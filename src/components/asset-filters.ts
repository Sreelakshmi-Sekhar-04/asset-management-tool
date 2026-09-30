/** Convert list URL params into the server's AssetFilters shape (used for select-all-matching bulk actions). */
export function assetFiltersFromQuery(query: string) {
  const u = new URLSearchParams(query);
  const all = (k: string) => u.getAll(k).flatMap((v) => v.split(',')).filter(Boolean);
  const f: Record<string, unknown> = {};
  if (u.get('search')) f.search = u.get('search');
  if (all('categoryId').length) f.categoryIds = all('categoryId');
  if (all('status').length) f.statuses = all('status');
  for (const k of ['locationId', 'regionId', 'holderType', 'holderId', 'flag']) if (u.get(k)) f[k] = u.get(k);
  if (u.get('warrantyWithinDays')) f.warrantyWithinDays = Number(u.get('warrantyWithinDays'));
  if (u.get('warrantyExpired') === 'true') f.warrantyExpired = true;
  if (u.get('hasOpenTransfer')) f.hasOpenTransfer = u.get('hasOpenTransfer') === 'true';
  return f;
}
