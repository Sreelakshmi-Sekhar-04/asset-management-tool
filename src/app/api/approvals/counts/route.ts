import { route, body, paging, q, qList } from '@/server/http';
import { inboxCounts } from '@/server/services/approvals';

export const GET = route({}, async ({ actor }) => inboxCounts(actor));
