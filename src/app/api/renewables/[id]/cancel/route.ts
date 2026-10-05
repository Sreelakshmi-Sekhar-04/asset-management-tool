import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { cancelRenewable } from '@/server/services/renewables';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => cancelRenewable(actor, params.id, (await body(req, z.object({ reason: z.string().trim().min(1, 'A reason is required').max(1000) }))).reason));
