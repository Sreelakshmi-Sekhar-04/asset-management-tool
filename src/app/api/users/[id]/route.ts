import { route, body, paging, q, qList } from '@/server/http';
import { getUser, updateUser } from '@/server/services/users';

export const GET = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ params }) => getUser(params.id));
export const PATCH = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => updateUser(actor, params.id, await req.json()));
