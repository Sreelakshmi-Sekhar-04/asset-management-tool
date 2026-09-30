import { route, body, paging, q, qList } from '@/server/http';
import { getTransfer } from '@/server/services/transfers';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => getTransfer(actor, params.id));
