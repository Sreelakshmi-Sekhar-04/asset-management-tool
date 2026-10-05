import { route, body, paging, q, qList } from '@/server/http';
import { createEmployee, listEmployees } from '@/server/services/employees';

export const GET = route({}, async ({ actor, url }) => listEmployees(actor, { search: q(url, 'search'), departmentId: q(url, 'departmentId'), locationId: q(url, 'locationId'), active: q(url, 'active'), holding: q(url, 'holding'), ...paging(url) }));
export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => createEmployee(actor, await req.json()));
