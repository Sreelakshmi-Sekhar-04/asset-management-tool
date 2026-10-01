import { route } from '@/server/http';
import { addUnlisted } from '@/server/services/verification';

export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => addUnlisted(actor, params.id, await req.json()));
