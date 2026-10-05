import { route, body, paging, q, qList } from '@/server/http';
import { saveReminderPolicy } from '@/server/services/renewables';

export const PUT = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => saveReminderPolicy(actor, params.id, await req.json()));
