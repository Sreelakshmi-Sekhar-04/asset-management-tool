import { route, body, paging, q, qList } from '@/server/http';
import { createDepartment, listDepartments } from '@/server/services/master';

export const GET = route({}, async ({ url }) => listDepartments(q(url, 'includeInactive') === 'true'));
export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => createDepartment(actor, await req.json()));
