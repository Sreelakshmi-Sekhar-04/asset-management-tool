import { route } from '@/server/http';
import { checkInAsset } from '@/server/services/lifecycle';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => checkInAsset(actor, params.id, await req.json()));
