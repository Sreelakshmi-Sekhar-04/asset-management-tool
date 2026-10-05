import { z } from 'zod';
import { prisma, tx, type Db } from '@/lib/db';
import { badRequest, conflict } from '@/lib/errors';
import { categoryCode, formatAssetId, validateAssetIdFormat, type AssetIdFormat } from '@/lib/asset-id';
import { todayIST } from '@/lib/format';
import type { Actor } from '../actor';
import { audit } from '../audit';
import { getSettings, invalidateSettings } from '../settings';
import { requireRole } from '../scope';

/**
 * Issue Asset IDs for new assets, one per category id, in order. Numbers come from
 * asset_code_seq, which never hands out the same value twice, so concurrent creates
 * cannot collide. A format change could in theory reproduce an ID issued under an older
 * format (e.g. prefix "A1" + 023 vs "A" + 1023); such numbers are skipped.
 */
export async function nextAssetCodes(t: Db, categoryIds: string[]): Promise<string[]> {
  if (!categoryIds.length) return [];
  const { assetIdFormat: f } = await getSettings(t);
  const cats = await t.assetCategory.findMany({ where: { id: { in: [...new Set(categoryIds)] } }, select: { id: true, code: true, name: true } });
  const codeOf = new Map(cats.map((c) => [c.id, categoryCode(c)]));
  const year = Number(todayIST().slice(0, 4));
  const out: string[] = [];
  let pending = categoryIds.map((id, i) => ({ i, cat: codeOf.get(id) ?? 'GEN' }));
  for (let attempt = 0; pending.length && attempt < 5; attempt++) {
    const seqs = await t.$queryRaw<{ n: bigint }[]>`SELECT nextval('asset_code_seq') AS n FROM generate_series(1, ${pending.length}::int)`;
    const tried = pending.map((p, k) => ({ ...p, code: formatAssetId(f, { seq: Number(seqs[k].n), cat: p.cat, year }) }));
    const taken = new Set((await t.asset.findMany({ where: { assetCode: { in: tried.map((x) => x.code) } }, select: { assetCode: true } })).map((a) => a.assetCode));
    for (const x of tried) if (!taken.has(x.code)) out[x.i] = x.code;
    pending = tried.filter((x) => taken.has(x.code));
  }
  if (pending.length) throw conflict('Could not issue a unique Asset ID. Ask an administrator to review the Asset ID format.');
  return out;
}

/** The running number the next asset will receive (reading it does not consume it). */
async function nextNumber(db: Db = prisma) {
  const [r] = await db.$queryRaw<{ last_value: bigint; is_called: boolean }[]>`SELECT last_value, is_called FROM asset_code_seq`;
  return Number(r.last_value) + (r.is_called ? 1 : 0);
}

export async function getAssetIdConfig(actor: Actor) {
  requireRole(actor, 'ADMIN');
  const [s, next, cats, issued] = await Promise.all([
    getSettings(),
    nextNumber(),
    prisma.assetCategory.findMany({ where: { active: true }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } }),
    prisma.asset.count(),
  ]);
  return {
    format: s.assetIdFormat,
    nextNumber: next,
    year: Number(todayIST().slice(0, 4)),
    issued,
    categories: cats.map((c) => ({ ...c, effectiveCode: categoryCode(c) })),
  };
}

const configInput = z.object({
  prefix: z.string().trim().toUpperCase(),
  pattern: z.string().trim(),
  padding: z.number().int(),
  /** Optional: move the running number forward (never back, so issued numbers are never reused). */
  nextNumber: z.number().int().positive().max(999_999_999).optional(),
});

export async function updateAssetIdConfig(actor: Actor, input: unknown) {
  requireRole(actor, 'ADMIN');
  const d = configInput.parse(input);
  const format: AssetIdFormat = { prefix: d.prefix, pattern: d.pattern.replace(/\{([a-z]+)\}/gi, (_, t: string) => `{${t.toUpperCase()}}`), padding: d.padding };
  const problems = validateAssetIdFormat(format);
  if (problems.length) throw badRequest('The Asset ID format is not valid.', problems);
  await tx(async (t) => {
    const before = (await getSettings(t)).assetIdFormat;
    const current = await nextNumber(t);
    if (d.nextNumber !== undefined && d.nextNumber < current) {
      throw badRequest(`The next number can only move forward (it is ${current} now), so issued numbers are never reused.`, [{ field: 'nextNumber', message: `At least ${current}` }]);
    }
    await t.setting.upsert({ where: { key: 'assetIdFormat' }, update: { value: { ...format }, updatedBy: actor.id }, create: { key: 'assetIdFormat', value: { ...format }, updatedBy: actor.id } });
    if (d.nextNumber !== undefined && d.nextNumber > current) await t.$queryRaw`SELECT setval('asset_code_seq', ${d.nextNumber}::bigint, false)`;
    await audit(t, actor, {
      action: 'SETTINGS_CHANGED', entityType: 'Settings', entityLabel: 'Asset ID format',
      before: { ...before, nextNumber: current }, after: { ...format, nextNumber: d.nextNumber ?? current },
    });
  });
  invalidateSettings();
  return getAssetIdConfig(actor);
}
