import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { resolveIdentifiers } from '@/server/services/transfers';

export const POST = route({}, async ({ req, actor }) => {
  const d = await body(req, z.object({ text: z.string().max(500_000).default(''), fromLocationId: z.string().optional(), assetIds: z.array(z.string()).max(20_000).optional() }));
  return resolveIdentifiers(actor, d.text, d.fromLocationId, d.assetIds);
});
