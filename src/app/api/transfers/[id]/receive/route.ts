import { route, body } from '@/server/http';
import { receiptInput, receiveTransfer } from '@/server/services/transfer-receipt';

/** The destination confirms what arrived and its condition. */
export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => receiveTransfer(actor, params.id, await body(req, receiptInput)));
