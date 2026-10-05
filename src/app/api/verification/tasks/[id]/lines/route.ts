import { route, body, paging, q, qList } from '@/server/http';
import { listTaskLines } from '@/server/services/verification';

export const GET = route<{ id: string }>({}, async ({ actor, params, url }) => listTaskLines(actor, params.id, { search: q(url, 'search'), result: q(url, 'result'), inTransit: q(url, 'inTransit') === 'true', ...paging(url) }));
