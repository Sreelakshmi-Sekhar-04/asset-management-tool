import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { DEFAULT_ASSET_ID_FORMAT, DEFAULT_LABEL_SETTINGS, extractAssetCode } from '@/lib/asset-code';
import { PUT as putAssetIds } from '@/app/api/settings/asset-ids/route';
import { GET as getQr } from '@/app/api/assets/[id]/qr/route';
import { assetQr, labelsPdf } from '@/server/pdf';
import { getAssetIdConfig, updateAssetIdFormat, updateLabelSettings } from '@/server/services/asset-id';
import { bulkAddAssets, lookupAsset, updateAsset } from '@/server/services/assets';
import { createCategory, updateCategory } from '@/server/services/master';
import { invalidateSettings } from '@/server/settings';
import { world, type World } from './fixtures';
import { call, rejectsWith, sessionCookie } from './helpers';

let w: World;
let code: string;
beforeAll(async () => {
  w = await world();
  code = `L${w.s.slice(-4).toUpperCase()}`;
  await updateCategory(w.admin.actor, w.cat.id, { code });
});
afterAll(async () => {
  const cfg = await getAssetIdConfig();
  await updateAssetIdFormat(w.admin.actor, { ...DEFAULT_ASSET_ID_FORMAT, nextNumber: cfg.nextGlobal });
  await updateLabelSettings(w.admin.actor, DEFAULT_LABEL_SETTINGS);
  invalidateSettings();
});

describe('Asset ID format', () => {
  it('keeps the FRD format AST-000001 until an administrator changes it', async () => {
    expect((await w.asset(w.A.id)).assetCode).toMatch(/^AST-\d{6,}$/);
  });

  it('new assets follow a changed format, with separate numbering per prefix; existing IDs never change', async () => {
    const old = await w.asset(w.A.id);
    await updateAssetIdFormat(w.admin.actor, { prefix: 'it', separator: '-', includeCategoryCode: true, digits: 5, numbering: 'PER_PREFIX', startNumber: 1 });
    const a1 = await w.asset(w.A.id);
    const a2 = await w.asset(w.B.id);
    expect(a1.assetCode).toBe(`IT-${code}-00001`);
    expect(a2.assetCode).toBe(`IT-${code}-00002`);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: old.id } })).assetCode).toBe(old.assetCode);

    // A category without a code gets no category part, and counts on its own.
    const plain = await createCategory(w.admin.actor, { name: `Monitor ${w.s}` });
    const r = await bulkAddAssets(w.it.actor, { categoryId: plain.id, make: 'LG', model: '24MK', locationId: w.A.id, items: [{}, {}, {}] }, { skipApproval: true });
    expect(r.created?.map((x) => x.assetCode)).toEqual(['IT-00001', 'IT-00002', 'IT-00003']);

    // Editing an asset (even its category) keeps its Asset ID.
    await updateAsset(w.it.actor, a1.id, { categoryId: plain.id, serialNumber: a1.serialNumber });
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a1.id } })).assetCode).toBe(`IT-${code}-00001`);
  });

  it('the database assigns the ID even when a caller tries to supply one', async () => {
    const src = await w.asset(w.A.id);
    await prisma.$executeRaw`
      INSERT INTO assets SELECT (jsonb_populate_record(NULL::assets, to_jsonb(a) || jsonb_build_object('id', ${`forged-${w.s}`}, 'assetCode', 'FORGED-1', 'serialNumber', NULL))).* FROM assets a WHERE a.id = ${src.id}`;
    const forged = await prisma.asset.findUniqueOrThrow({ where: { id: `forged-${w.s}` } });
    expect(forged.assetCode).not.toBe('FORGED-1');
    expect(forged.assetCode).toMatch(new RegExp(`^IT-${code}-\\d{5}$`));
  });

  it('switching numbering never produces an ID that already exists', async () => {
    await updateAssetIdFormat(w.admin.actor, { ...DEFAULT_ASSET_ID_FORMAT });
    const g = await w.asset(w.A.id);
    await updateAssetIdFormat(w.admin.actor, { ...DEFAULT_ASSET_ID_FORMAT, numbering: 'PER_PREFIX' });
    const p = await w.asset(w.A.id);
    expect(Number(p.assetCode.slice(4))).toBeGreaterThan(Number(g.assetCode.slice(4)));
    const all = await prisma.asset.findMany({ select: { assetCode: true } });
    expect(new Set(all.map((x) => x.assetCode)).size).toBe(all.length);
  });

  it('the shared running number can move forward but never back', async () => {
    const cfg = await getAssetIdConfig();
    await rejectsWith(updateAssetIdFormat(w.admin.actor, { ...DEFAULT_ASSET_ID_FORMAT, nextNumber: cfg.nextGlobal - 1 }), 400, /never reused/);
    await updateAssetIdFormat(w.admin.actor, { ...DEFAULT_ASSET_ID_FORMAT, nextNumber: cfg.nextGlobal + 500 });
    expect((await w.asset(w.A.id)).assetCode).toBe(`AST-${String(cfg.nextGlobal + 500).padStart(6, '0')}`);
  });

  it('rejects invalid formats with a readable message, and only Administrators may change it', async () => {
    const bad = await call(putAssetIds, { url: '/api/settings/asset-ids', method: 'PUT', cookie: await sessionCookie(w.admin.user.email), body: { ...DEFAULT_ASSET_ID_FORMAT, prefix: 'A B' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/letters or digits/);
    const it = await call(putAssetIds, { url: '/api/settings/asset-ids', method: 'PUT', cookie: await sessionCookie(w.it.user.email), body: DEFAULT_ASSET_ID_FORMAT });
    expect(it.status).toBe(403);
  });
});

describe('QR codes, labels and scanning', () => {
  it('reads both bare Asset IDs and scan links', () => {
    expect(extractAssetCode(' AST-000123 ')).toBe('AST-000123');
    expect(extractAssetCode('https://assets.example.com/scan/IT-LAP-00001')).toBe('IT-LAP-00001');
    expect(extractAssetCode('/scan/AST-000009?x=1')).toBe('AST-000009');
    expect(extractAssetCode('SN-123/456')).toBe('SN-123/456');
  });

  it('a scanned label finds the right asset, within the scanner’s scope only', async () => {
    const a = await w.asset(w.A.id);
    expect((await lookupAsset(w.brA.actor, `http://localhost:3000/scan/${a.assetCode}`)).id).toBe(a.id);
    expect((await lookupAsset(w.it.actor, a.assetCode.toLowerCase())).id).toBe(a.id);
    await rejectsWith(lookupAsset(w.brC.actor, a.assetCode), 404);
  });

  it('QR content follows the label setting and is scope-checked', async () => {
    const a = await w.asset(w.A.id);
    expect((await assetQr(w.it.actor, a.id, 'svg')).payload).toBe(a.assetCode);
    await updateLabelSettings(w.admin.actor, { ...DEFAULT_LABEL_SETTINGS, qrContent: 'LINK' });
    const link = (await assetQr(w.it.actor, a.id, 'png')).payload;
    expect(link).toMatch(new RegExp(`/scan/${a.assetCode}$`));
    expect((await lookupAsset(w.it.actor, link)).id).toBe(a.id);
    const ok = await call(getQr, { url: `/api/assets/${a.id}/qr`, cookie: await sessionCookie(w.brA.user.email), params: { id: a.id } });
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get('content-type')).toBe('image/svg+xml');
    const denied = await call(getQr, { url: `/api/assets/${a.id}/qr`, cookie: await sessionCookie(w.brC.user.email), params: { id: a.id } });
    expect(denied.status).toBe(404);
  });

  it('prints labels on an A4 sheet or a label printer, for in-scope assets only', async () => {
    const a = await w.asset(w.A.id), b = await w.asset(w.A.id);
    const sheet = await labelsPdf(w.it.actor, { assetIds: [a.id, b.id], skip: 5 });
    expect(sheet.data.subarray(0, 4).toString()).toBe('%PDF');
    expect(sheet.count).toBe(2);
    const roll = await labelsPdf(w.it.actor, { assetIds: [a.id, b.id], layout: 'LABEL_PRINTER' });
    expect((roll.data.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(2);
    await rejectsWith(labelsPdf(w.brC.actor, { assetIds: [a.id] }), 400, /within your scope/);
    expect(await prisma.auditLog.count({ where: { action: 'LABELS_GENERATED', entityLabel: '2 label(s)' } })).toBeGreaterThanOrEqual(2);
  });
});
