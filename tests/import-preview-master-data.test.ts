import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { confirmImport, getImport, importRows, removeImportRows, replaceImportValue, revalidateImport, runCommit, runValidation, setRowSelection, startImport } from '@/server/import/engine';
import { createLocation } from '@/server/services/locations';
import { createDepartment } from '@/server/services/master';
import { importRowStatus } from '@/lib/import-row-status';
import { world, type World } from './fixtures';
import { rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

/**
 * The Excel Upload preview: missing locations and departments are shown (never created by the dry
 * run), can be added from the preview and the rows are checked again; rows can be ticked, unticked
 * and removed from the batch; only ticked, valid, not removed rows are imported.
 */
describe('Excel Upload preview: missing master data, selection and removal', () => {
  const header = 'Category,Make,Model,Serial Number,Location,Department';
  const file = (rows: string[]) => Buffer.from([header, ...rows].join('\n'));
  const branchA = () => `Region ${w.s}/State1 ${w.s}/Branch A ${w.s}`;
  const sn = (k: string) => `PV-${k}-${w.s}`;
  const dry = async (name: string, rows: string[]) => {
    const job = await startImport(w.it.actor, { type: 'ASSETS', createMissing: true, fileName: name, data: file(rows) });
    await runValidation(job.id);
    return job.id;
  };
  const all = async (jobId: string, outcome?: string) => (await importRows(w.it.actor, jobId, { outcome, skip: 0, take: 100 })).rows as { rowNumber: number; outcome: string; messages: string[]; selected: boolean; removed: boolean }[];
  const preview = async (jobId: string) => ((await getImport(w.it.actor, jobId)) as { preview: { total: number; selected: number; importable: number; removed: number; missingLocations: { value: string; rows: number }[]; missingDepartments: { value: string; rows: number }[] } }).preview;

  it('1–5: a known location is valid; a missing location or department is reported, not created, and the row turns valid once it is added', async () => {
    const locsBefore = await prisma.location.count();
    const deptsBefore = await prisma.department.count();
    const missingLoc = `Region ${w.s}/State1 ${w.s}/Trivandrum Branch ${w.s}`;
    const jobId = await dry('master.csv', [
      `${w.cat.name},Dell,Latitude,${sn('ok')},${branchA()},`,
      `${w.cat.name},Dell,Latitude,${sn('loc')},${missingLoc},`,
      `${w.cat.name},Dell,Latitude,${sn('dept')},${branchA()},IT ${w.s}`,
    ]);
    // The upload asked for "create missing", but an asset dry run never creates master data.
    const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.createMissing).toBe(false);
    expect(job.locationsToCreate).toEqual([]);
    expect(await prisma.location.count()).toBe(locsBefore);
    expect(await prisma.department.count()).toBe(deptsBefore);

    let rows = await all(jobId);
    expect(rows.map((r) => importRowStatus(r.outcome, r.messages))).toEqual(['NEW', 'MISSING_LOCATION', 'MISSING_DEPARTMENT']);
    expect(rows[1].messages).toContain(`Location not found: "${missingLoc}".`);
    expect(rows[2].messages).toContain(`Department not found: "IT ${w.s}".`);
    expect(await preview(jobId)).toMatchObject({ total: 3, importable: 1, missingLocations: [{ value: missingLoc, rows: 1 }], missingDepartments: [{ value: `IT ${w.s}`, rows: 1 }] });
    expect((await all(jobId, 'MISSING_LOCATION')).map((r) => r.rowNumber)).toEqual([3]);

    // Add the location where the path says (under State1), then check again: the row is valid.
    await createLocation(w.admin.actor, { name: `Trivandrum Branch ${w.s}`, parentId: w.st1.id, type: 'BRANCH' });
    await revalidateImport(w.it.actor, jobId);
    rows = await all(jobId);
    expect(rows[1].outcome).toBe('CREATED');

    // A department added under another name: the rows are pointed at it and become valid.
    const d = await createDepartment(w.admin.actor, { name: `Information Technology ${w.s}` });
    await expect(replaceImportValue(w.it.actor, jobId, { field: 'department', from: `it ${w.s}`, to: d.name })).resolves.toMatchObject({ updated: 1 });
    rows = await all(jobId);
    expect(rows.map((r) => r.outcome)).toEqual(['CREATED', 'CREATED', 'CREATED']);
    expect(await preview(jobId)).toMatchObject({ importable: 3, missingLocations: [], missingDepartments: [] });

    await confirmImport(w.it.actor, jobId, undefined, 3);
    await runCommit(jobId);
    const held = await prisma.asset.findFirstOrThrow({ where: { serialNormalized: sn('dept').toLowerCase() } });
    expect(held).toMatchObject({ status: 'ASSIGNED', holderType: 'DEPARTMENT', holderDepartmentId: d.id });
    expect((await prisma.asset.findFirstOrThrow({ where: { serialNormalized: sn('loc').toLowerCase() }, include: { location: true } })).location?.name).toBe(`Trivandrum Branch ${w.s}`);
  });

  it('6, 7, 11: Delete and Delete selected take only those rows out of the batch, and never delete an asset, location or department', async () => {
    const existing = await w.asset(w.A.id, { serialNumber: sn('existing'), make: 'Dell', model: 'Latitude' });
    const jobId = await dry('remove.csv', [
      `${w.cat.name},Dell,Latitude,${sn('r1')},${branchA()},${w.dept.name}`,
      `${w.cat.name},Dell,Latitude,${sn('r2')},${branchA()},`,
      `${w.cat.name},Dell,Latitude,${sn('existing')},${branchA()},`,
      `${w.cat.name},Dell,Latitude,${sn('r4')},${branchA()},`,
      `${w.cat.name},Dell,Latitude,${sn('r2')},${branchA()},`,
    ]);
    const before = { assets: await prisma.asset.count(), locations: await prisma.location.count(), departments: await prisma.department.count() };
    // Row 6 repeats row 3's serial, so it is invalid until row 3 goes.
    expect((await all(jobId)).find((r) => r.rowNumber === 6)?.outcome).toBe('REJECTED');

    // Delete one row: only that row leaves the preview, and the rest is checked again without it.
    await removeImportRows(w.it.actor, jobId, [3]);
    let rows = await all(jobId);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 4, 5, 6]);
    expect(rows.find((r) => r.rowNumber === 6)?.outcome).toBe('CREATED');
    expect((await all(jobId, 'REMOVED')).map((r) => r.rowNumber)).toEqual([3]);
    expect(await preview(jobId)).toMatchObject({ total: 4, removed: 1 });

    // Delete selected: untick everything, tick rows 4 and 5 (row 4 matches an asset already in the register).
    await setRowSelection(w.it.actor, jobId, { all: true, selected: false });
    await setRowSelection(w.it.actor, jobId, { rows: [4, 5], selected: true });
    await removeImportRows(w.it.actor, jobId, 'selected');
    rows = await all(jobId);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 6]);
    expect(await preview(jobId)).toMatchObject({ total: 2, removed: 3, selected: 0 });

    expect(await prisma.asset.count()).toBe(before.assets);
    expect(await prisma.location.count()).toBe(before.locations);
    expect(await prisma.department.count()).toBe(before.departments);
    expect(await prisma.asset.findUnique({ where: { id: existing.id } })).toBeTruthy();
    expect(await prisma.department.findUnique({ where: { id: w.dept.id } })).toMatchObject({ active: true });

    // A removed row can be put back, ticked again.
    await removeImportRows(w.it.actor, jobId, [5], false);
    expect((await all(jobId)).find((r) => r.rowNumber === 5)).toMatchObject({ removed: false, selected: true });
    await rejectsWith(removeImportRows(w.brA.actor, jobId, [2]), 403);
  });

  it('8–10: only selected, valid, not removed rows are imported, with their latest edited values', async () => {
    const jobId = await dry('select.csv', [
      `${w.cat.name},Dell,Latitude,${sn('s1')},${branchA()},`,
      `${w.cat.name},Dell,Latitude,${sn('s2')},${branchA()},`,
      `${w.cat.name},Dell,Latitude,${sn('s3')},Nowhere ${w.s},`,
      `${w.cat.name},Dell,Latitude,${sn('s4')},${branchA()},`,
    ]);
    await setRowSelection(w.it.actor, jobId, { rows: [3], selected: false }); // 8: unticked
    await removeImportRows(w.it.actor, jobId, [5]); // removed
    // Row 4 (missing location) stays ticked but unresolved: 9.
    expect(await preview(jobId)).toMatchObject({ total: 3, selected: 2, importable: 1 });

    // The final check runs on confirm: a count that no longer matches stops it, and nothing is queued.
    await rejectsWith(confirmImport(w.it.actor, jobId, undefined, 3), 409, /final check/);
    expect((await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('VALIDATED');

    await confirmImport(w.it.actor, jobId, undefined, 1);
    await runCommit(jobId);
    const j = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(j.status).toBe('COMMITTED');
    expect(j.counts).toMatchObject({ CREATED: 1, REJECTED: 1, NOT_SELECTED: 1 });
    const imported = await prisma.asset.findMany({ where: { serialNormalized: { in: ['s1', 's2', 's3', 's4'].map((k) => sn(k).toLowerCase()) } } });
    expect(imported.map((a) => a.serialNumber)).toEqual([sn('s1')]);
  });

  it('nothing ticked and valid means nothing to import', async () => {
    const jobId = await dry('none.csv', [`${w.cat.name},Dell,Latitude,${sn('n1')},${branchA()},`]);
    await setRowSelection(w.it.actor, jobId, { all: true, selected: false });
    await rejectsWith(confirmImport(w.it.actor, jobId), 400, /no selected row is valid/);
  });
});
