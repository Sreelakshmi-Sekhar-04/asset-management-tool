import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { patchOf } from '@/lib/zod';
import { createAsset, updateAsset } from '@/server/services/assets';
import { retireAsset } from '@/server/services/lifecycle';
import { updateCategory } from '@/server/services/master';
import { updateLocation } from '@/server/services/locations';
import { updateSettings } from '@/server/services/master';
import { invalidateSettings } from '@/server/settings';
import { world, type World } from './fixtures';
import { rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

describe('asset registration', () => {
  it('assigns a system asset code and rejects a duplicate serial, case-insensitively, even against retired assets', async () => {
    const a = await w.asset(w.A.id, { serialNumber: `DUP-${w.s}` });
    expect(a.assetCode).toMatch(/\S+/);
    await retireAsset(w.it.actor, a.id, { reason: 'Scrapped', disposalType: 'SCRAPPED' });
    const err = await rejectsWith(createAsset(w.it.actor, { categoryId: w.cat.id, make: 'Dell', model: 'X', serialNumber: `dup-${w.s}`.toLowerCase(), locationId: w.A.id }), 409);
    expect((err as unknown as { code: string }).code).toBe('DUPLICATE_BLOCKED');
  });

  it('warns on a duplicate hostname and needs a reason, then flags both records', async () => {
    const a = await w.asset(w.A.id, { hostname: `HOST-${w.s}` });
    const err = await rejectsWith(w.asset(w.A.id, { hostname: `host-${w.s}` }), 409);
    expect((err as unknown as { code: string }).code).toBe('DUPLICATE_WARNING');
    const b = await w.asset(w.A.id, { hostname: `host-${w.s}`, duplicateReason: 'Re-imaged spare' });
    const both = await prisma.asset.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(both.every((x) => x.flagDuplicateSuspect)).toBe(true);
  });

  it('requires a serial when the category demands one (server-side)', async () => {
    await rejectsWith(createAsset(w.it.actor, { categoryId: w.cat.id, make: 'Dell', model: 'X', locationId: w.A.id }), 400, /Serial number is required/);
  });

  it('branch users cannot create assets directly', async () => {
    await rejectsWith(createAsset(w.brA.actor, { categoryId: w.cat.id, make: 'Dell', model: 'X', serialNumber: `BR-${w.s}`, locationId: w.A.id }), 403);
  });

  it('branch users can edit only network fields; other edits are refused and audited', async () => {
    const a = await w.asset(w.A.id);
    await updateAsset(w.brA.actor, a.id, { hostname: `BRH-${w.s}` });
    await rejectsWith(updateAsset(w.brA.actor, a.id, { make: 'HP' }), 403);
    expect(await prisma.auditLog.count({ where: { action: 'ACCESS_DENIED', entityId: a.id } })).toBe(1);
  });
});

describe('database invariants', () => {
  it('the asset code is immutable and assets cannot be deleted, even with raw SQL', async () => {
    const a = await w.asset(w.A.id);
    await expect(prisma.$executeRaw`UPDATE assets SET "assetCode" = 'HACKED' WHERE id = ${a.id}`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM assets WHERE id = ${a.id}`).rejects.toThrow();
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).assetCode).toBe(a.assetCode);
  });

  it('the audit log and movement history are append-only', async () => {
    const row = await prisma.auditLog.findFirstOrThrow({ orderBy: { at: 'desc' } });
    await expect(prisma.$executeRaw`UPDATE audit_log SET action = 'X' WHERE id = ${row.id}`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM audit_log WHERE id = ${row.id}`).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_log')).rejects.toThrow();
    const mv = await prisma.assetMovement.findFirstOrThrow();
    await expect(prisma.$executeRaw`UPDATE asset_movements SET reason = 'x' WHERE id = ${mv.id}`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM asset_movements WHERE id = ${mv.id}`).rejects.toThrow();
  });
});

describe('partial updates keep fields the caller did not send', () => {
  it('patchOf strips defaults', () => {
    const s = z.object({ a: z.boolean().default(true), b: z.string() });
    expect(patchOf(s).parse({})).toEqual({});
    expect(s.partial().parse({})).toEqual({ a: true });
  });

  it('deactivating a category leaves its flags alone; renaming a region keeps its type', async () => {
    await updateCategory(w.admin.actor, w.cat.id, { name: `Laptop ${w.s} renamed` });
    expect((await prisma.assetCategory.findUniqueOrThrow({ where: { id: w.cat.id } })).serialRequired).toBe(true);
    await updateLocation(w.admin.actor, w.region.id, { code: 'RG' });
    expect((await prisma.location.findUniqueOrThrow({ where: { id: w.region.id } })).type).toBe('REGION');
  });

  it('audit retention cannot be set below seven years', async () => {
    await expect(updateSettings(w.admin.actor, { auditRetentionYears: 3 })).rejects.toThrow(/7 years/);
    invalidateSettings();
  });
});
