import { route, body, paging, q, qList } from '@/server/http';
import { submitTransfer } from '@/server/services/transfers';

export const POST = route<{ id: string }>({}, async ({ actor, params }) => submitTransfer(actor, params.id));
