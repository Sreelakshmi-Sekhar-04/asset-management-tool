import { route, body, paging, q, qList } from '@/server/http';
import { listRequests } from '@/server/services/approvals';

export const GET = route({}, async ({ actor, url }) => listRequests(actor, { status: q(url, 'status'), action: q(url, 'action'), mine: q(url, 'mine') === 'true', actionable: q(url, 'actionable') === 'true', ...paging(url) }));
