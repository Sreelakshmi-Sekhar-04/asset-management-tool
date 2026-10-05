import { route } from '@/server/http';
import { getAssetIdConfig, updateAssetIdConfig } from '@/server/services/asset-id';

export const GET = route({ roles: ['ADMIN'] }, async ({ actor }) => getAssetIdConfig(actor));
export const PUT = route({ roles: ['ADMIN'] }, async ({ req, actor }) => updateAssetIdConfig(actor, await req.json()));
