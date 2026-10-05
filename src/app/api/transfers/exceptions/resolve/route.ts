import { route, body, paging, q, qList } from '@/server/http';
import { resolveExceptions } from '@/server/services/transfers';

export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => resolveExceptions(actor, await req.json()));
