import { route } from '@/server/http';
import { getAssetIdConfig, updateAssetIdFormat } from '@/server/services/asset-id';

export const GET = route({ roles: ['ADMIN'] }, async () => getAssetIdConfig());
export const PUT = route({ roles: ['ADMIN'] }, async ({ req, actor }) => updateAssetIdFormat(actor, await req.json()));
