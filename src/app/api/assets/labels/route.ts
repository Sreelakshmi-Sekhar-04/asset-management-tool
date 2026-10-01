import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { fileResponse } from '@/server/export';
import { labelsPdf } from '@/server/pdf';

export const POST = route({}, async ({ req, actor }) => {
  const d = await body(req, z.object({ assetIds: z.array(z.string()).min(1).max(2000) }));
  return fileResponse(await labelsPdf(actor, d.assetIds));
});
