import { route, body, paging, q, qList } from '@/server/http';
import { badRequest } from '@/lib/errors';
import { assetAsOf } from '@/server/services/history';

export const GET = route<{ id: string }>({}, async ({ actor, params, url }) => {
  const date = q(url, 'date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Give a date as YYYY-MM-DD.');
  return assetAsOf(actor, params.id, date);
});
