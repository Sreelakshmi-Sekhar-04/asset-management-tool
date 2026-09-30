import { route, body, paging, q, qList } from '@/server/http';
import { listSources, saveSource } from '@/server/services/integrations';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor }) => listSources(actor));
export const POST = route({ roles: ['ADMIN'] }, async ({ req, actor }) => saveSource(actor, null, await req.json()));
