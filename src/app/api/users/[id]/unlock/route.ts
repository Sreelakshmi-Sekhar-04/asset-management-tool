import { route } from '@/server/http';
import { unlockUser } from '@/server/services/users';

export const POST = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ actor, params }) => unlockUser(actor, params.id));
