import { route } from '@/server/http';
import { bulkAssign } from '@/server/services/lifecycle';

export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => bulkAssign(actor, await req.json()));
