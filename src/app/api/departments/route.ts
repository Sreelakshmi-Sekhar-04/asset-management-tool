import { route, q } from '@/server/http';
import { createDepartment, listDepartments } from '@/server/services/master';

export const GET = route({}, async ({ actor, url }) => listDepartments(actor, q(url, 'includeInactive') === 'true'));
export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => createDepartment(actor, await req.json()));
