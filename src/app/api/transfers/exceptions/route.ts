import { route, body, paging, q, qList } from '@/server/http';
import { listExceptions } from '@/server/services/transfers';

export const GET = route({}, async ({ actor, url }) => listExceptions(actor, { status: q(url, 'status'), ...paging(url) }));
