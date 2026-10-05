import { z } from 'zod';
import { prisma, tx } from '@/lib/db';
import { badRequest } from '@/lib/errors';
import { assetCodeHead, formatAssetCode, type AssetIdFormat } from '@/lib/asset-code';
import type { Actor } from '../actor';
import { audit } from '../audit';
import { getSettings, invalidateSettings } from '../settings';

/**
 * Asset ID format and label settings. The database assigns every Asset ID
 * (trigger assets_assign_code), so this service only stores the format and moves the
 * shared counter forward when asked. Existing Asset IDs are never changed.
 */

const MAX_NUMBER = 999_999_999_999;

export const assetIdFormatInput = z.object({
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'Use 1 to 10 letters or digits, no spaces or symbols.'),
  separator: z.enum(['-', '']),
  includeCategoryCode: z.boolean(),
  digits: z.number().int().min(3, 'At least 3 digits.').max(10, 'At most 10 digits.'),
  numbering: z.enum(['GLOBAL', 'PER_PREFIX']),
  startNumber: z.number().int().min(1).max(MAX_NUMBER),
  /** GLOBAL only: move the shared running number forward. Never backwards. */
  nextNumber: z.number().int().min(1).max(MAX_NUMBER).optional(),
});

export const labelSettingsInput = z.object({
  qrContent: z.enum(['ASSET_ID', 'LINK']),
  layout: z.enum(['A4_SHEET', 'LABEL_PRINTER']),
  labelWidthMm: z.number().int().min(25, 'At least 25 mm wide.').max(150, 'At most 150 mm wide.'),
  labelHeightMm: z.number().int().min(15, 'At least 15 mm high.').max(100, 'At most 100 mm high.'),
});

/** The number the shared sequence will hand out next. */
async function nextGlobalNumber() {
  const [r] = await prisma.$queryRaw<{ last_value: bigint; is_called: boolean }[]>`SELECT last_value, is_called FROM asset_code_seq`;
  return Number(r.is_called ? r.last_value + 1n : r.last_value);
}

export async function getAssetIdConfig() {
  const s = await getSettings();
  const [nextGlobal, counters, categories, total] = await Promise.all([
    nextGlobalNumber(),
    prisma.assetCodeCounter.findMany({ orderBy: { prefix: 'asc' } }),
    prisma.assetCategory.findMany({ where: { active: true }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } }),
    prisma.asset.count(),
  ]);
  return {
    format: s.assetIdFormat,
    labels: s.labels,
    nextGlobal,
    counters: counters.map((c) => ({ prefix: c.prefix, nextValue: Number(c.nextValue) })),
    categories,
    assetCount: total,
    appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  };
}

function nextFor(f: AssetIdFormat, head: string, nextGlobal: number, counters: Map<string, number>) {
  return f.numbering === 'GLOBAL' ? nextGlobal : counters.get(head) ?? f.startNumber;
}

/** What the next asset in each category would get (an estimate; the database assigns the real ID on save). */
export async function previewAssetIds(f: AssetIdFormat) {
  const [nextGlobal, counters, categories] = await Promise.all([
    nextGlobalNumber(), prisma.assetCodeCounter.findMany(), prisma.assetCategory.findMany({ where: { active: true }, select: { name: true, code: true }, orderBy: { name: 'asc' } }),
  ]);
  const m = new Map(counters.map((c) => [c.prefix, Number(c.nextValue)]));
  const rows = (f.includeCategoryCode ? categories : [{ name: 'All categories', code: null }]).map((c) => {
    const head = assetCodeHead(f, c.code);
    return { category: c.name, code: c.code, example: formatAssetCode(f, nextFor(f, head, nextGlobal, m), c.code) };
  });
  return rows;
}

export async function updateAssetIdFormat(actor: Actor, input: unknown) {
  const { nextNumber, ...f } = assetIdFormatInput.parse(input);
  const nextGlobal = await nextGlobalNumber();
  if (f.numbering === 'GLOBAL' && nextNumber !== undefined && nextNumber < nextGlobal) {
    throw badRequest(`Numbers below ${nextGlobal} have already been handed out and are never reused. Enter ${nextGlobal} or higher.`, [{ field: 'nextNumber', message: `Must be ${nextGlobal} or higher` }]);
  }
  if (assetCodeHead(f, 'XXXXXX').length + f.digits > 40) throw badRequest('That format makes Asset IDs longer than 40 characters. Shorten the prefix or the number of digits.');
  const before = (await getSettings()).assetIdFormat;
  await tx(async (t) => {
    await t.setting.upsert({ where: { key: 'assetIdFormat' }, update: { value: f, updatedBy: actor.id }, create: { key: 'assetIdFormat', value: f, updatedBy: actor.id } });
    if (f.numbering === 'GLOBAL' && nextNumber !== undefined && nextNumber > nextGlobal) await t.$executeRaw`SELECT setval('asset_code_seq', ${nextNumber - 1}::bigint, true)`;
    await audit(t, actor, {
      action: 'ASSET_ID_FORMAT_CHANGED', entityType: 'Settings', entityLabel: 'Asset ID format', before: { ...before, nextNumber: nextGlobal }, after: { ...f, nextNumber: nextNumber ?? nextGlobal },
    });
  });
  invalidateSettings();
  return getAssetIdConfig();
}

export async function updateLabelSettings(actor: Actor, input: unknown) {
  const d = labelSettingsInput.parse(input);
  const before = (await getSettings()).labels;
  await tx(async (t) => {
    await t.setting.upsert({ where: { key: 'labels' }, update: { value: d, updatedBy: actor.id }, create: { key: 'labels', value: d, updatedBy: actor.id } });
    await audit(t, actor, { action: 'SETTINGS_CHANGED', entityType: 'Settings', entityLabel: 'labels', before: { labels: before }, after: { labels: d } });
  });
  invalidateSettings();
  return getAssetIdConfig();
}
