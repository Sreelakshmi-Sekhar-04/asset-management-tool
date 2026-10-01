import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { bulkReassign } from '@/server/services/lifecycle';

export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => {
  const d = await body(req, z.object({ assetIds: z.array(z.string()).min(1).max(20000), toEmployeeId: z.string().min(1), remarks: z.string().max(1000).default('') }));
  return bulkReassign(actor, d.assetIds, d.toEmployeeId, d.remarks);
});
