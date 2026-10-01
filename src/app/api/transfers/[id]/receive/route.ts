import { route, body, paging, q, qList } from '@/server/http';
import { receive } from '@/server/services/transfers';

export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => receive(actor, params.id, await req.json()));
