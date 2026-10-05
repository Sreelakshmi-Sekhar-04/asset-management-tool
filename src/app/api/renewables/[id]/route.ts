import { route, body, paging, q, qList } from '@/server/http';
import { getRenewable, updateRenewable } from '@/server/services/renewables';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => getRenewable(actor, params.id));
export const PATCH = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => updateRenewable(actor, params.id, await req.json()));
