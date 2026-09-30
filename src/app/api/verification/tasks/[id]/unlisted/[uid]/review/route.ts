import { route, body, paging, q, qList } from '@/server/http';
import { reviewUnlisted } from '@/server/services/verification';

export const POST = route<{ id: string; uid: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => reviewUnlisted(actor, params.id, params.uid, await req.json()));
