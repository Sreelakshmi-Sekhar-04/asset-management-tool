import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { reassignTask } from '@/server/services/approvals';

export const POST = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => {
  const d = await body(req, z.object({ toUserId: z.string().min(1), comment: z.string().max(2000).optional() }));
  return reassignTask(actor, params.id, d.toUserId, d.comment);
});
