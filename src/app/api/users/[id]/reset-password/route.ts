import { route } from '@/server/http';
import { adminResetPassword } from '@/server/services/users';

export const POST = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ actor, params }) => adminResetPassword(actor, params.id));
