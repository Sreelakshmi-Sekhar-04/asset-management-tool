import { route } from '@/server/http';
import { emailsForRequest } from '@/server/services/notifications';

/** The emails this request sent, with their real delivery state (queued, sent, or failed and why). */
export const GET = route<{ id: string }>({}, async ({ actor, params }) => emailsForRequest(actor, params.id));
