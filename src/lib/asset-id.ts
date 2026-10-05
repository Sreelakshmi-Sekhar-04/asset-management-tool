/**
 * Asset ID format: pure helpers shared by the server (issuing IDs) and the settings
 * screen (live preview). The running number comes from one global sequence
 * (asset_code_seq), so it never repeats across categories, years or format changes.
 */
export interface AssetIdFormat {
  prefix: string;
  pattern: string;
  padding: number;
}

export const ASSET_ID_TOKENS = [
  { token: '{PREFIX}', label: 'Prefix' },
  { token: '{CAT}', label: 'Category code' },
  { token: '{YYYY}', label: 'Year (2026)' },
  { token: '{YY}', label: 'Year (26)' },
  { token: '{SEQ}', label: 'Running number' },
] as const;

/** Reproduces the original AST-000001 IDs exactly, so nothing changes until an administrator edits it. */
export const DEFAULT_ASSET_ID_FORMAT: AssetIdFormat = { prefix: 'AST', pattern: '{PREFIX}-{SEQ}', padding: 6 };

export const CATEGORY_CODE_RE = /^[A-Z0-9]{1,6}$/;

/** Category code used for {CAT}: the configured code, else the first three letters/digits of the name. */
export function categoryCode(c: { code?: string | null; name: string }): string {
  return c.code || c.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'GEN';
}

export function formatAssetId(f: AssetIdFormat, p: { seq: number; cat: string; year: number }): string {
  return f.pattern
    .replaceAll('{PREFIX}', f.prefix)
    .replaceAll('{CAT}', p.cat)
    .replaceAll('{YYYY}', String(p.year))
    .replaceAll('{YY}', String(p.year % 100).padStart(2, '0'))
    .replaceAll('{SEQ}', String(p.seq).padStart(f.padding, '0'))
    .toUpperCase();
}

/** Field-level problems with a format, or an empty list when it is valid. */
export function validateAssetIdFormat(f: AssetIdFormat): { field: 'prefix' | 'pattern' | 'padding'; message: string }[] {
  const out: { field: 'prefix' | 'pattern' | 'padding'; message: string }[] = [];
  if (!/^[A-Z0-9]{1,8}$/.test(f.prefix)) out.push({ field: 'prefix', message: 'Use 1–8 capital letters or digits.' });
  if (!Number.isInteger(f.padding) || f.padding < 3 || f.padding > 9) out.push({ field: 'padding', message: 'Between 3 and 9 digits.' });
  const p = f.pattern;
  if (!p.includes('{SEQ}')) out.push({ field: 'pattern', message: 'The pattern must include {SEQ} so every Asset ID is unique.' });
  else if ((p.match(/\{SEQ\}/g) ?? []).length > 1) out.push({ field: 'pattern', message: 'Use {SEQ} only once.' });
  const unknown = (p.match(/\{[^}]*\}/g) ?? []).find((t) => !ASSET_ID_TOKENS.some((x) => x.token === t));
  if (unknown) out.push({ field: 'pattern', message: `Unknown token ${unknown}. Allowed: ${ASSET_ID_TOKENS.map((x) => x.token).join(' ')}.` });
  const literal = p.replace(/\{(PREFIX|CAT|YYYY|YY|SEQ)\}/g, '');
  if (/[^A-Za-z0-9\-_/.]/.test(literal)) out.push({ field: 'pattern', message: 'Outside tokens, use only letters, digits and - _ / .' });
  if (p.length > 40) out.push({ field: 'pattern', message: 'Keep the pattern under 40 characters.' });
  return out;
}
