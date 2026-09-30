import { route } from '@/server/http';
import { resendInvite } from '@/server/services/users';

export const POST = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ actor, params }) => resendInvite(actor, params.id));
