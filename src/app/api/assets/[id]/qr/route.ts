import { route } from '@/server/http';
import { fileResponse } from '@/server/export';
import { assetQrSvg } from '@/server/pdf';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => fileResponse(await assetQrSvg(actor, params.id)));
