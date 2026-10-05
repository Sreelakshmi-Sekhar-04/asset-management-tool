import { route, body, paging, q, qList } from '@/server/http';
import { markRenewed } from '@/server/services/renewables';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => markRenewed(actor, params.id, await req.json()));
