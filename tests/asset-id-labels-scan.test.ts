import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { DEFAULT_ASSET_ID_FORMAT } from '@/lib/asset-id';
import { assetQrSvg, labelsPdf } from '@/server/pdf';
import { getAssetIdConfig, updateAssetIdConfig } from '@/server/services/asset-id';
import { bulkAddAssets, getAssetDetail, lookupAsset, updateAsset } from '@/server/services/assets';
import { createCategory, updateCategory } from '@/server/services/master';
import { invalidateSettings } from '@/server/settings';
import { world, type World } from './fixtures';
import { rejectsWith } from './helpers';

let w: World;
let code: string;
beforeAll(async () => {
  w = await world();
  code = `L${w.s.slice(-5)}`.toUpperCase();
  await updateCategory(w.sys, w.cat.id, { code });
});
afterAll(async () => {
  await updateAssetIdConfig(w.admin.actor, DEFAULT_ASSET_ID_FORMAT);
  invalidateSettings();
});

describe('Asset ID format', () => {
  it('keeps the original AST-000001 format by default', async () => {
    await updateAssetIdConfig(w.admin.actor, DEFAULT_ASSET_ID_FORMAT);
    const a = await w.asset(w.A.id);
    expect(a.assetCode).toMatch(/^AST-\d{6,}$/);
  });

  it('applies a new format to new assets only; existing Asset IDs and edits are unaffected', async () => {
    const before = await w.asset(w.A.id);
    await updateAssetIdConfig(w.admin.actor, { prefix: 'it', pattern: '{prefix}-{CAT}-{SEQ}', padding: 5 });
    const after = await w.asset(w.A.id);
    expect(after.assetCode).toMatch(new RegExp(`^IT-${code}-\\d{5,}$`));
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: before.id } })).assetCode).toBe(before.assetCode);
    await updateAsset(w.it.actor, after.id, { remarks: 'Label attached' });
    const d = await getAssetDetail(w.it.actor, after.assetCode.toLowerCase());
    expect(d.id).toBe(after.id);
    expect(d.assetCode).toBe(after.assetCode);
  });

  it('issues unique IDs in bulk and falls back to a name-derived code for categories without one', async () => {
    const r = await bulkAddAssets(w.it.actor, { categoryId: w.cat.id, make: 'HP', model: 'ProBook', locationId: w.A.id, items: [1, 2, 3].map((i) => ({ serialNumber: `BULK-${w.s}-${i}` })) });
    const codes = (r as { created: { assetCode: string }[] }).created.map((c) => c.assetCode);
    expect(new Set(codes).size).toBe(3);
    const other = await createCategory(w.sys, { name: `Monitor ${w.s}`, serialRequired: false });
    const m = await w.asset(w.A.id, { categoryId: other.id });
    expect(m.assetCode).toMatch(/^IT-MON-\d{5,}$/);
  });

  it('moves the running number forward only, and the next asset uses it', async () => {
    const cfg = await getAssetIdConfig(w.admin.actor);
    await rejectsWith(updateAssetIdConfig(w.admin.actor, { ...cfg.format, nextNumber: cfg.nextNumber - 1 }), 400, /only move forward/);
    const target = cfg.nextNumber + 50;
    await updateAssetIdConfig(w.admin.actor, { ...cfg.format, nextNumber: target });
    const a = await w.asset(w.A.id);
    expect(a.assetCode).toBe(`IT-${code}-${String(target).padStart(5, '0')}`);
  });

  it('rejects invalid formats and non-administrators', async () => {
    await rejectsWith(updateAssetIdConfig(w.admin.actor, { prefix: 'IT', pattern: '{PREFIX}-{CAT}', padding: 6 }), 400);
    await rejectsWith(updateAssetIdConfig(w.admin.actor, { prefix: 'IT', pattern: '{PREFIX}-{LOC}-{SEQ}', padding: 6 }), 400);
    await rejectsWith(updateAssetIdConfig(w.admin.actor, { prefix: 'IT', pattern: '{PREFIX} {SEQ}', padding: 6 }), 400);
    await rejectsWith(updateAssetIdConfig(w.admin.actor, { prefix: 'IT', pattern: '{SEQ}', padding: 12 }), 400);
    await rejectsWith(updateAssetIdConfig(w.it.actor, DEFAULT_ASSET_ID_FORMAT), 403);
    await rejectsWith(getAssetIdConfig(w.brA.actor), 403);
  });

  it('validates category codes and keeps them unique', async () => {
    await rejectsWith(createCategory(w.sys, { name: `Phone ${w.s}`, code }), 409, /already used/);
    // Services throw the validation error; the route wrapper turns it into a 400.
    await expect(createCategory(w.sys, { name: `Phone ${w.s}`, code: 'TOO-LONG' })).rejects.toThrow(/capital letters/);
  });
});

describe('scan lookup', () => {
  it('finds an asset by Asset ID, serial or bare running number, within scope only', async () => {
    const a = await w.asset(w.A.id, { serialNumber: `SCAN-${w.s}` });
    expect(await lookupAsset(w.brA.actor, a.assetCode)).toMatchObject({ id: a.id, matchedBy: 'assetCode' });
    expect(await lookupAsset(w.brA.actor, `scan-${w.s}`)).toMatchObject({ id: a.id, matchedBy: 'serial' });
    const n = String(Number(/(\d+)$/.exec(a.assetCode)![1]));
    expect(await lookupAsset(w.it.actor, n)).toMatchObject({ id: a.id, matchedBy: 'number' });
    // Out-of-scope assets look exactly like unknown codes.
    await rejectsWith(lookupAsset(w.brC.actor, a.assetCode), 404);
    await rejectsWith(lookupAsset(w.brC.actor, n), 404);
    await rejectsWith(lookupAsset(w.it.actor, `NOPE-${w.s}`), 404);
  });
});

describe('labels and QR codes', () => {
  it('prints one thermal label per page and an A4 sheet, skipping out-of-scope assets', async () => {
    const mine = [await w.asset(w.A.id), await w.asset(w.A.id)];
    const theirs = await w.asset(w.C.id);
    const ids = [...mine.map((a) => a.id), theirs.id];
    const pages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    const thermal = await labelsPdf(w.brA.actor, ids, 'THERMAL_50x25');
    expect(thermal.count).toBe(2);
    expect(pages(thermal.data)).toBe(2);
    const sheet = await labelsPdf(w.it.actor, ids);
    expect(sheet.count).toBe(3);
    expect(pages(sheet.data)).toBe(1);
  });

  it('serves the QR of the Asset ID, scoped like the asset itself', async () => {
    const a = await w.asset(w.A.id);
    const qr = await assetQrSvg(w.brA.actor, a.id);
    expect(qr.mime).toBe('image/svg+xml');
    expect(qr.data.toString()).toContain('<svg');
    await rejectsWith(assetQrSvg(w.brC.actor, a.id), 404);
  });
});
