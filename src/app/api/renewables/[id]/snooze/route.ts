import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { snooze } from '@/server/services/renewables';

export const POST = route<{ id: string }>({}, async ({ req, actor, params }) => {
  const d = await body(req, z.object({ until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'), note: z.string().max(1000).optional() }));
  return snooze(actor, params.id, d.until, d.note);
});
