import { route, body, paging, q, qList } from '@/server/http';
import { listLines } from '@/server/services/transfers';

export const GET = route<{ id: string }>({}, async ({ actor, params, url }) => listLines(actor, params.id, { status: q(url, 'status'), search: q(url, 'search'), ...paging(url) }));
