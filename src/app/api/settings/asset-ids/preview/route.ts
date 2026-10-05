import { route } from '@/server/http';
import { assetIdFormatInput, previewAssetIds } from '@/server/services/asset-id';

export const POST = route({ roles: ['ADMIN'] }, async ({ req }) => previewAssetIds(assetIdFormatInput.parse(await req.json())));
