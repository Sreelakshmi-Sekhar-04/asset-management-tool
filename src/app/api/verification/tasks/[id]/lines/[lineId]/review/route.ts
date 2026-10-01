import { route, body, paging, q, qList } from '@/server/http';
import { reviewLine } from '@/server/services/verification';

export const POST = route<{ id: string; lineId: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => reviewLine(actor, params.id, params.lineId, await req.json()));
