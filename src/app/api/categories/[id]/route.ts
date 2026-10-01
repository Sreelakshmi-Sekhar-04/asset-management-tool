import { route, body, paging, q, qList } from '@/server/http';
import { updateCategory } from '@/server/services/master';

export const PATCH = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => updateCategory(actor, params.id, await req.json()));
