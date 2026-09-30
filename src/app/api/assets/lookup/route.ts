import { route, body, paging, q, qList } from '@/server/http';
import { lookupAsset } from '@/server/services/assets';

export const GET = route({}, async ({ actor, url }) => lookupAsset(actor, q(url, 'q') ?? ''));
