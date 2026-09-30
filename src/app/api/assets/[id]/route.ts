import { route, body, paging, q, qList } from '@/server/http';
import { getAssetDetail, updateAsset } from '@/server/services/assets';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => getAssetDetail(actor, params.id));
export const PATCH = route<{ id: string }>({}, async ({ req, actor, params }) => updateAsset(actor, params.id, await req.json()));
