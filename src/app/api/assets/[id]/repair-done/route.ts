import { route } from '@/server/http';
import { completeRepair } from '@/server/services/lifecycle';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => completeRepair(actor, params.id, await req.json()));
