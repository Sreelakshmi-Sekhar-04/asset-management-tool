import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { POST as devicesHook } from '@/app/api/integrations/[source]/devices/route';
import { issueApiKey, revokeApiKey, saveSource, resolveConflict } from '@/server/services/integrations';
import { updateAsset } from '@/server/services/assets';
import { confirmImport, editImportRow, importReportCsv, importRows, purgeExpiredImportReports, revalidateImport, runCommit, runValidation, startImport } from '@/server/import/engine';
import { world, type World } from './fixtures';
import { call, rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

describe('generic device hook', () => {
  let key = '', sourceKey = '';
  const push = (body: unknown, auth = `Bearer ${key}`) => call(devicesHook, { url: `/api/integrations/${sourceKey}/devices`, method: 'POST', body, params: { source: sourceKey }, headers: { authorization: auth } });

  beforeAll(async () => {
    sourceKey = `mdm-${w.s}`.toLowerCase().slice(0, 40);
    const s = await saveSource(w.admin.actor, null, { key: sourceKey, name: `MDM ${w.s}`, kind: 'DEVICE' });
    key = (await issueApiKey(w.admin.actor, s.id)).apiKey;
  });

  it('refuses a bad credential and audits the attempt without storing the secret', async () => {
    const r = await push({ records: [{ serialNumber: 'x' }] }, 'Bearer itam_nope_nope');
    expect(r.status).toBe(401);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'INTEGRATION_AUTH_FAILED', entityLabel: sourceKey }, orderBy: { at: 'desc' } });
    expect(JSON.stringify({ details: row.details, label: row.entityLabel })).not.toContain('itam_nope_nope');
    const stored = await prisma.integrationSource.findUniqueOrThrow({ where: { key: sourceKey } });
    expect(stored.apiKeyHash).not.toContain(key);
  });

  it('fills empty fields, queues conflicts on manually set ones, and is idempotent per batch', async () => {
    const a = await w.asset(w.A.id, { hostname: `MANUAL-${w.s}` });
    const body = { batchId: `b1-${w.s}`, records: [
      { serialNumber: a.serialNumber, hostname: `AGENT-${w.s}`, ipAddress: '10.1.2.3', os: 'Windows 11' },
      { serialNumber: `UNKNOWN-${w.s}`, hostname: 'stray' },
    ] };
    const r1 = await push(body);
    expect(r1.status).toBe(202);
    expect(r1.json.counts).toMatchObject({ received: 2, updated: 1, conflicts: 1, unmatched: 1 });
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.ipAddress).toBe('10.1.2.3');
    expect(after.hostname).toBe(`MANUAL-${w.s}`);
    const r2 = await push(body);
    expect(r2.json.status).toBe('DUPLICATE');
    expect(await prisma.integrationUnmatched.count({ where: { externalId: `serial:UNKNOWN-${w.s}` } })).toBe(1);

    const conflict = await prisma.integrationConflict.findFirstOrThrow({ where: { entityId: a.id, field: 'hostname', status: 'OPEN' } });
    await rejectsWith(resolveConflict(w.brA.actor, conflict.id, 'ACCEPT_INCOMING'), 403);
    await resolveConflict(w.it.actor, conflict.id, 'ACCEPT_INCOMING');
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).hostname).toBe(`AGENT-${w.s}`);
    // A later manual edit of a source-owned field raises a new conflict for IT to decide.
    await updateAsset(w.it.actor, a.id, { hostname: `MANUAL2-${w.s}` });
    expect(await prisma.integrationConflict.count({ where: { entityId: a.id, field: 'hostname', status: 'OPEN' } })).toBe(1);
  });

  it('a revoked key stops working', async () => {
    const s = await prisma.integrationSource.findUniqueOrThrow({ where: { key: sourceKey } });
    await revokeApiKey(w.admin.actor, s.id);
    expect((await push({ records: [{ serialNumber: 'x' }] })).status).toBe(401);
  });
});

describe('imports', () => {
  const csv = (rows: string[]) => Buffer.from(['Category,Make,Model,Serial Number,Location', ...rows].join('\n'));
  const loc = () => `Region ${w.s}/State1 ${w.s}/Branch A ${w.s}`;

  it('a dry run writes nothing; commit applies exactly what the dry run showed', async () => {
    const before = await prisma.asset.count();
    const job = await startImport(w.it.actor, { type: 'ASSETS', mode: 'CREATE_ONLY', createMissing: false, fileName: 'a.csv', data: csv([
      `${w.cat.name},Dell,Latitude,IMP1-${w.s},${loc()}`,
      `${w.cat.name},Dell,Latitude,,${loc()}`,
      `Nope,Dell,Latitude,IMP2-${w.s},${loc()}`,
    ]) });
    await runValidation(job.id);
    const v = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(v.status).toBe('VALIDATED');
    expect(v.counts).toMatchObject({ CREATED: 1, REJECTED: 2 });
    expect(await prisma.asset.count()).toBe(before);
    await confirmImport(w.it.actor, job.id);
    await runCommit(job.id);
    expect((await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('COMMITTED');
    expect(await prisma.asset.count({ where: { serialNormalized: `imp1-${w.s}`.toLowerCase() } })).toBe(1);
    expect(await prisma.asset.count()).toBe(before + 1);
  });

  it('a commit refuses to apply when the data changed after the dry run', async () => {
    const job = await startImport(w.it.actor, { type: 'ASSETS', mode: 'CREATE_ONLY', createMissing: false, fileName: 'b.csv', data: csv([`${w.cat.name},HP,EliteBook,DRIFT-${w.s},${loc()}`]) });
    await runValidation(job.id);
    await w.asset(w.A.id, { serialNumber: `DRIFT-${w.s}` });
    await confirmImport(w.it.actor, job.id);
    await runCommit(job.id);
    const j = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.status).toBe('FAILED');
    expect(j.error).toMatch(/changed since the dry run/);
  });

  it('flags a serial that is already registered even when the row has other errors, and the preview rows carry the matched Asset ID', async () => {
    const taken = await w.asset(w.A.id, { serialNumber: `TAKEN-${w.s}` });
    const job = await startImport(w.it.actor, { type: 'ASSETS', mode: 'CREATE_ONLY', createMissing: false, fileName: 'taken.csv', data: csv([`${w.cat.name},HP,EliteBook,TAKEN-${w.s},Nowhere ${w.s}`]) });
    await runValidation(job.id);
    const { rows } = await importRows(w.it.actor, job.id, { skip: 0, take: 10 });
    expect(rows[0].outcome).toBe('REJECTED');
    expect(rows[0].messages.join(' ')).toMatch(/Unknown location.*Duplicate: serial TAKEN-.* already exists on /);
    expect((rows[0] as { view?: { asset: { id: string } | null } }).view?.asset?.id).toBe(taken.id);
  });

  it('rows corrected in the preview are checked again and imported with the corrected values', async () => {
      const job = await startImport(w.it.actor, { type: 'ASSETS', mode: 'CREATE_ONLY', createMissing: false, fileName: 'fix.csv', data: csv([
      `${w.cat.name},Dell,Latitude,,${loc()}`,
      `${w.cat.name},HP,EliteBook,FIX2-${w.s},${loc()}`,
      `Nope,Lenovo,ThinkPad,FIX3-${w.s},${loc()}`,
      ]) });
      await runValidation(job.id);
      let { rows } = await importRows(w.it.actor, job.id, { skip: 0, take: 10 });
      expect(rows.map((r) => r.outcome)).toEqual(['REJECTED', 'CREATED', 'REJECTED']);
      expect(rows[0].messages.join(' ')).toMatch(/Serial number is required/);

      // A serial that repeats another row is caught on the edited row.
      await editImportRow(w.it.actor, job.id, 2, { serialnumber: `FIX2-${w.s}` });
      ({ rows } = await importRows(w.it.actor, job.id, { skip: 0, take: 10 }));
      expect(rows[1].outcome).toBe('REJECTED');
      expect(rows[1].messages.join(' ')).toMatch(/duplicated within the file \(rows 2 and 3\)/);

      await editImportRow(w.it.actor, job.id, 2, { serialnumber: ` SN-FIXED-${w.s} ` });
      await editImportRow(w.it.actor, job.id, 4, { category: w.cat.name, legacytag: `LT-${w.s}`, ipaddress: '10.99.1.7' });
      ({ rows } = await importRows(w.it.actor, job.id, { skip: 0, take: 10 }));
      expect(rows.map((r) => r.outcome)).toEqual(['CREATED', 'CREATED', 'CREATED']);
      expect((await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).counts).toMatchObject({ CREATED: 3, REJECTED: 0 });
      await expect(revalidateImport(w.it.actor, job.id)).resolves.toMatchObject({ counts: { CREATED: 3 } });

      await rejectsWith(editImportRow(w.it.actor, job.id, 2, { assetcode: 'X' }), 400);
      await rejectsWith(editImportRow(w.brA.actor, job.id, 2, { serialnumber: 'X' }), 403);

      await confirmImport(w.it.actor, job.id);
      await rejectsWith(editImportRow(w.it.actor, job.id, 2, { serialnumber: 'LATE' }), 409);
      await runCommit(job.id);
      expect((await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('COMMITTED');
      expect(await prisma.asset.findFirst({ where: { serialNormalized: `sn-fixed-${w.s}`.toLowerCase() } })).toMatchObject({ make: 'Dell', serialNumber: `SN-FIXED-${w.s}` });
      expect(await prisma.asset.findFirst({ where: { serialNormalized: `fix3-${w.s}`.toLowerCase() } })).toMatchObject({ categoryId: w.cat.id, legacyTag: `LT-${w.s}`, ipAddress: '10.99.1.7' });
  });

  it('a row already in the register is reported as a duplicate and skipped', async () => {
    const job = await startImport(w.it.actor, { type: 'ASSETS', mode: 'CREATE_ONLY', createMissing: false, fileName: 'dup.csv', data: csv([`${w.cat.name},Dell,Latitude,IMP1-${w.s},${loc()}`]) });
    await runValidation(job.id);
    const { rows } = await importRows(w.it.actor, job.id, { skip: 0, take: 10 });
    expect(rows[0].outcome).toBe('UNCHANGED');
    expect(rows[0].messages[0]).toMatch(/^Duplicate of /);
    expect((await importReportCsv(w.it.actor, job.id)).data.toString()).toMatch(/,Duplicate,/);
  });

  it('with no mode chosen, each row is found to be new, existing (update) or a duplicate, and a duplicate says what matched', async () => {
    const existing = await w.asset(w.A.id, { serialNumber: `AUTO-EX-${w.s}`, model: 'Latitude' });
    const same = await w.asset(w.A.id, { serialNumber: `AUTO-DUP-${w.s}`, make: 'Dell', model: 'Latitude', legacyTag: `LT-AUTO-${w.s}` });
    const job = await startImport(w.it.actor, { type: 'ASSETS', createMissing: false, fileName: 'auto.csv', data: Buffer.from([
      'Category,Make,Model,Serial Number,Legacy Tag,Location',
      `${w.cat.name},Dell,Latitude,AUTO-NEW-${w.s},,${loc()}`,
      `${w.cat.name},Dell,Latitude 7440,AUTO-EX-${w.s},,${loc()}`,
      `${w.cat.name},Dell,Latitude,AUTO-DUP-${w.s},LT-AUTO-${w.s},${loc()}`,
    ].join('\n')) });
    expect(job.mode).toBe('CREATE_OR_UPDATE');
    await runValidation(job.id);
    const { rows } = await importRows(w.it.actor, job.id, { skip: 0, take: 10 });
    expect(rows.map((r) => r.outcome)).toEqual(['CREATED', 'UPDATED', 'UNCHANGED']);
    expect(rows[1].matchedId).toBe(existing.id);
    const dup = (rows[2] as { view?: { duplicate?: unknown } }).view?.duplicate;
    expect(dup).toMatchObject({ field: 'serial', fieldLabel: 'Serial number', value: `AUTO-DUP-${w.s}`, asset: { id: same.id, assetCode: same.assetCode, name: 'Dell Latitude', serialNumber: `AUTO-DUP-${w.s}`, legacyTag: `LT-AUTO-${w.s}` } });
    await confirmImport(w.it.actor, job.id);
    await runCommit(job.id);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: existing.id } })).model).toBe('Latitude 7440');
    expect(await prisma.asset.count({ where: { serialNormalized: `auto-new-${w.s}`.toLowerCase() } })).toBe(1);
  });

  it('row reports are purged after the retention period, but the import log entry stays', async () => {
    const job = await startImport(w.it.actor, { type: 'ASSETS', mode: 'CREATE_ONLY', createMissing: false, fileName: 'old.csv', data: csv([`${w.cat.name},HP,EliteBook,OLD-${w.s},${loc()}`]) });
    await runValidation(job.id);
    await confirmImport(w.it.actor, job.id);
    await runCommit(job.id);
    await expect(importReportCsv(w.it.actor, job.id)).resolves.toBeTruthy();
    const old = new Date(); old.setUTCMonth(old.getUTCMonth() - 13);
    await prisma.importJob.update({ where: { id: job.id }, data: { createdAt: old } });
    await purgeExpiredImportReports();
    await rejectsWith(importReportCsv(w.it.actor, job.id), 409, /removed/);
    const j = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.counts).toMatchObject({ CREATED: 1 });
    expect(await prisma.importRow.count({ where: { jobId: job.id } })).toBe(0);
  });

  it('branch users cannot import', async () => {
    await rejectsWith(startImport(w.brA.actor, { type: 'ASSETS', mode: 'CREATE_ONLY', createMissing: false, fileName: 'c.csv', data: csv([]) }), 403);
  });
});
