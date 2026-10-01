import { route, body, paging, q, qList } from '@/server/http';
import { createRenewable, listRenewables } from '@/server/services/renewables';

export const GET = route({}, async ({ actor, url }) => listRenewables(actor, {
  type: qList(url, 'type'), status: qList(url, 'status'), locationId: q(url, 'locationId'), search: q(url, 'search'), assetId: q(url, 'assetId'),
  withinDays: q(url, 'withinDays') !== undefined ? Number(q(url, 'withinDays')) : undefined, expired: q(url, 'expired') === 'true',
}, paging(url)));
export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => createRenewable(actor, await req.json()));
