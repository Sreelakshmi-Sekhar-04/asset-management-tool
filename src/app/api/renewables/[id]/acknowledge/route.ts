import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { acknowledge } from '@/server/services/renewables';

export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => acknowledge(actor, params.id, (await body(req, z.object({ note: z.string().max(1000).optional() }))).note));
