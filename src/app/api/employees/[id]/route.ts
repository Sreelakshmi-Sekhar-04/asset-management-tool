import { route, body, paging, q, qList } from '@/server/http';
import { getEmployee, updateEmployee } from '@/server/services/employees';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => getEmployee(actor, params.id));
export const PATCH = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params, url }) => updateEmployee(actor, params.id, await req.json(), { confirmDeactivate: q(url, 'confirmDeactivate') === 'true' }));
