import { route, body, paging, q, qList } from '@/server/http';
import { updateDepartment } from '@/server/services/master';

export const PATCH = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => updateDepartment(actor, params.id, await req.json()));
