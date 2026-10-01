import { route } from '@/server/http';
import { startRepair } from '@/server/services/lifecycle';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => startRepair(actor, params.id, await req.json()));
