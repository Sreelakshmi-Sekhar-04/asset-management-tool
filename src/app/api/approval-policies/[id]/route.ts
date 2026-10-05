import { route, body, paging, q, qList } from '@/server/http';
import { deletePolicy, savePolicy } from '@/server/services/approvals';

export const PUT = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => savePolicy(actor, params.id, await req.json()));
export const DELETE = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ actor, params }) => deletePolicy(actor, params.id));
