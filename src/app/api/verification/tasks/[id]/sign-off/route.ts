import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { signOff } from '@/server/services/verification';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => signOff(actor, params.id, (await body(req, z.object({ note: z.string().max(1000).optional() }))).note));
