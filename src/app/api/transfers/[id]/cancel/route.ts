import { route, body, paging, q, qList } from '@/server/http';
import { cancelTransfer } from '@/server/services/transfers';

export const POST = route<{ id: string }>({}, async ({ actor, params }) => cancelTransfer(actor, params.id));
