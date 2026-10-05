import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { markRead } from '@/server/services/notifications';

export const POST = route({}, async ({ req, actor }) => {
  const d = await body(req, z.object({ ids: z.union([z.array(z.string()).max(500), z.literal('all')]) }));
  return markRead(actor, d.ids);
});
