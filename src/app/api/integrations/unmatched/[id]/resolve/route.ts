import { route, body, paging, q, qList } from '@/server/http';
import { resolveUnmatched } from '@/server/services/integrations';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => resolveUnmatched(actor, params.id, await req.json()));
