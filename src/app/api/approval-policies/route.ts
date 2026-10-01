import { route, body, paging, q, qList } from '@/server/http';
import { listPolicies, savePolicy } from '@/server/services/approvals';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async () => listPolicies());
export const POST = route({ roles: ['ADMIN'] }, async ({ req, actor }) => savePolicy(actor, null, await req.json()));
