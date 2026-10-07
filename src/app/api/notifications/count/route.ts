import { route } from '@/server/http';
import { unreadCount } from '@/server/services/notifications';

/** Just the unread count, for the bell in the header (cheaper than the whole /auth/me payload). */
export const GET = route({}, async ({ actor }) => ({ unread: await unreadCount(actor) }));
