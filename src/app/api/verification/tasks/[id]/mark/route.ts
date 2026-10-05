import { route } from '@/server/http';
import { markLines } from '@/server/services/verification';

export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => markLines(actor, params.id, await req.json()));
