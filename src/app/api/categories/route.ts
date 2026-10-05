import { route, body, paging, q, qList } from '@/server/http';
import { createCategory, listCategories } from '@/server/services/master';

export const GET = route({}, async ({ url }) => listCategories(q(url, 'includeInactive') === 'true'));
export const POST = route({ roles: ['ADMIN'] }, async ({ req, actor }) => createCategory(actor, await req.json()));
