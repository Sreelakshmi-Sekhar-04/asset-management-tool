import { route, body, paging, q, qList } from '@/server/http';
import { createUser, listUsers } from '@/server/services/users';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ url }) => listUsers({ search: q(url, 'search'), role: q(url, 'role'), active: q(url, 'active'), ...paging(url) }));
export const POST = route({ roles: ['ADMIN'] }, async ({ req, actor }) => createUser(actor, await req.json()));
