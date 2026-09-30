import { route } from '@/server/http';
import { retireAsset } from '@/server/services/lifecycle';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => retireAsset(actor, params.id, await req.json()));
