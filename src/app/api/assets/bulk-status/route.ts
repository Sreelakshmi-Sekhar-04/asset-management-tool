import { route, body, paging, q, qList } from '@/server/http';
import { bulkStatusChange } from '@/server/services/lifecycle';

export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => bulkStatusChange(actor, await req.json()));
