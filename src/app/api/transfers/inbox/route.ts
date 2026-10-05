import { route, body, paging, q, qList } from '@/server/http';
import { inbox } from '@/server/services/transfers';

export const GET = route({}, async ({ actor, url }) => inbox(actor, { ...paging(url), includeClosed: q(url, 'includeClosed') === 'true' }));
