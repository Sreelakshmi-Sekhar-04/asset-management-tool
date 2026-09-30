import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { scanLine } from '@/server/services/verification';

export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => scanLine(actor, params.id, (await body(req, z.object({ code: z.string().trim().min(1).max(200) }))).code));
