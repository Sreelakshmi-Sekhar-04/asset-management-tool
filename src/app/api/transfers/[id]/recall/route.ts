import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { recallTransfer } from '@/server/services/transfers';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => recallTransfer(actor, params.id, await body(req, z.object({ reason: z.string().trim().max(1000).optional(), lineIds: z.array(z.string()).optional() }))));
