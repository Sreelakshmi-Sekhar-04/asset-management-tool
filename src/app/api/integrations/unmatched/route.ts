import { route, body, paging, q, qList } from '@/server/http';
import { listUnmatched } from '@/server/services/integrations';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, url }) => listUnmatched(actor, { status: q(url, 'status'), sourceId: q(url, 'sourceId'), ...paging(url) }));
