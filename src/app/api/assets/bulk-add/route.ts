import { route, body, paging, q, qList } from '@/server/http';
import { bulkAddAssets } from '@/server/services/assets';

export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => bulkAddAssets(actor, await req.json()));
