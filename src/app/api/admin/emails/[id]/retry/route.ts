import { route, body, paging, q, qList } from '@/server/http';
import { retryEmail } from '@/server/services/notifications';

export const POST = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ actor, params }) => retryEmail(actor, params.id));
