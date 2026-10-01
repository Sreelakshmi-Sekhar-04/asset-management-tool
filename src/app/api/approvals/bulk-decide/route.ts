import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { bulkDecide } from '@/server/services/approvals';

export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => {
  const d = await body(req, z.object({ requestIds: z.array(z.string()).min(1).max(500), decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().max(2000).optional() }));
  return bulkDecide(actor, d.requestIds, d.decision, d.comment);
});
