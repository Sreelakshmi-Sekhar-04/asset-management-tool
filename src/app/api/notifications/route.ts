import { route, body, paging, q, qList } from '@/server/http';
import { listNotifications } from '@/server/services/notifications';

export const GET = route({}, async ({ actor, url }) => listNotifications(actor, { unread: q(url, 'unread') === 'true', ...paging(url) }));
