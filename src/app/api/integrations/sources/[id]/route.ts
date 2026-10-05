import { route, body, paging, q, qList } from '@/server/http';
import { getSource, saveSource } from '@/server/services/integrations';

export const GET = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => getSource(actor, params.id));
export const PUT = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => saveSource(actor, params.id, await req.json()));
