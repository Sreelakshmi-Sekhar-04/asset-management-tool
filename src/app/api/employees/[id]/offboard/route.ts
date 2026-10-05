import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { offboardEmployee } from '@/server/services/employees';

const input = z.object({ action: z.enum(['CHECK_IN', 'REASSIGN']), toEmployeeId: z.string().optional(), condition: z.string().max(120).optional(), remarks: z.string().max(1000).optional(), deactivate: z.boolean().optional() });
export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => offboardEmployee(actor, params.id, await body(req, input)));
