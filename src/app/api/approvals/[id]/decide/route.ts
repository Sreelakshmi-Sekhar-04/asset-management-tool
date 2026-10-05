import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { decide } from '@/server/services/approvals';

export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => {
  const d = await body(req, z.object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().max(2000).nullish() }));
  return decide(actor, params.id, d.decision, d.comment);
});
