import { route, body, paging, q, qList } from '@/server/http';
import { listEmailOutbox } from '@/server/services/notifications';

export const GET = route({ roles: ['ADMIN'] }, async ({ actor, url }) => listEmailOutbox(actor, { status: q(url, 'status'), ...paging(url) }));
