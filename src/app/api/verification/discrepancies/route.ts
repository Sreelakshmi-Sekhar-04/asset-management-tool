import { route, body, paging, q, qList } from '@/server/http';
import { discrepancies } from '@/server/services/verification';

export const GET = route({}, async ({ actor, url }) => discrepancies(actor, { campaignId: q(url, 'campaignId'), review: q(url, 'review'), ...paging(url) }));
