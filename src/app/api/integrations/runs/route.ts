import { route, body, paging, q, qList } from '@/server/http';
import { listRuns } from '@/server/services/integrations';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, url }) => listRuns(actor, { sourceId: q(url, 'sourceId'), status: q(url, 'status'), ...paging(url) }));
