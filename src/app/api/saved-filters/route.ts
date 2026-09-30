import { route, body, paging, q, qList } from '@/server/http';
import { listSavedFilters, saveFilter } from '@/server/services/notifications';

export const GET = route({}, async ({ actor, url }) => listSavedFilters(actor, q(url, 'page')));
export const POST = route({}, async ({ req, actor }) => saveFilter(actor, await req.json()));
