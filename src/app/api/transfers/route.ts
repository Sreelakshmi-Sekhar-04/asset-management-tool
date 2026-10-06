import { route, body, paging, q, qList } from '@/server/http';
import { createTransfer, listTransfers, type TransferFilters } from '@/server/services/transfers';

function filters(url: URL): TransferFilters {
  return {
    status: qList(url, 'status'), direction: q(url, 'direction') as TransferFilters['direction'], fromLocationId: q(url, 'fromLocationId'), toLocationId: q(url, 'toLocationId'),
    search: q(url, 'search'), transferNo: q(url, 'transferNo'), reason: q(url, 'reason'), dateFrom: q(url, 'dateFrom'), dateTo: q(url, 'dateTo'), interState: q(url, 'interState') === undefined ? undefined : q(url, 'interState') === 'true', requestedById: q(url, 'requestedById'),
  };
}

export const GET = route({}, async ({ actor, url }) => listTransfers(actor, filters(url), paging(url)));
export const POST = route({}, async ({ req, actor }) => createTransfer(actor, await req.json()));
