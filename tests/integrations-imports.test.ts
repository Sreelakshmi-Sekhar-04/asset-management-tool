import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { POST as devicesHook } from '@/app/api/integrations/[source]/devices/route';
import { issueApiKey, revokeApiKey, saveSource, resolveConflict } from '@/server/services/integrations';
import { updateAsset } from '@/server/services/assets';
import { confirmImport, importReportCsv, purgeExpiredImportReports, runCommit, runValidation, startImport } from '@/server/import/engine';
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
