import { route, body, paging, q, qList } from '@/server/http';
import { listTasks } from '@/server/services/verification';

export const GET = route({}, async ({ actor, url }) => listTasks(actor, { campaignId: q(url, 'campaignId'), status: q(url, 'status'), ...paging(url) }));
