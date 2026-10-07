import { route, body } from '@/server/http';
import { closeExceptionInput, closeNotReceived } from '@/server/services/transfer-receipt';

/** Administrator: an asset reported not received was found at the source; it stays there. */
export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => closeNotReceived(actor, params.id, await body(req, closeExceptionInput)));
