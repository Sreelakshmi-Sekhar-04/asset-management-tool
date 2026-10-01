import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { bulkCheckIn } from '@/server/services/lifecycle';

export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => {
  const d = await body(req, z.object({ assetIds: z.array(z.string()).min(1).max(20000), condition: z.string().max(120).optional(), remarks: z.string().max(1000).optional() }));
  return bulkCheckIn(actor, d.assetIds, d);
});
