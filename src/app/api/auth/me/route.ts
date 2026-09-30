import { route } from '@/server/http';
import { me } from '@/server/services/users';
import { unreadCount } from '@/server/services/notifications';

export const GET = route({}, async ({ actor }) => ({ user: await me(actor), scope: actor.scopeName, unread: await unreadCount(actor) }));
