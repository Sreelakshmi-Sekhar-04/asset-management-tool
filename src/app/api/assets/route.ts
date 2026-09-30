import { route, body, paging, q, qList } from '@/server/http';
import { createAsset, listAssets, type AssetFilters } from '@/server/services/assets';

function filters(url: URL): AssetFilters {
  const n = (k: string) => (q(url, k) !== undefined ? Number(q(url, k)) : undefined);
  const b = (k: string) => (q(url, k) === 'true' ? true : q(url, k) === 'false' ? false : undefined);
  return {
    search: q(url, 'search'), categoryIds: qList(url, 'categoryId'), statuses: qList(url, 'status'), locationId: q(url, 'locationId'), regionId: q(url, 'regionId'),
    holderType: q(url, 'holderType'), holderId: q(url, 'holderId'), warrantyWithinDays: n('warrantyWithinDays'), warrantyExpired: b('warrantyExpired'),
    flag: q(url, 'flag'), hasOpenTransfer: b('hasOpenTransfer'),
  };
}

export const GET = route({}, async ({ actor, url }) => listAssets(actor, filters(url), paging(url)));
export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => createAsset(actor, await req.json()));
