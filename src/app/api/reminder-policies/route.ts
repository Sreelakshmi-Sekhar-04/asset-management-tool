import { route, body, paging, q, qList } from '@/server/http';
import { listReminderPolicies, saveReminderPolicy } from '@/server/services/renewables';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async () => listReminderPolicies());
export const POST = route({ roles: ['ADMIN'] }, async ({ req, actor }) => saveReminderPolicy(actor, null, await req.json()));
