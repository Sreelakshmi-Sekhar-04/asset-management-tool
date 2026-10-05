import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { findDuplicates } from '@/server/services/assets';

const input = z.object({ serialNumber: z.string().nullish(), legacyTag: z.string().nullish(), hostname: z.string().nullish(), ipAddress: z.string().nullish(), excludeId: z.string().optional() });
export const POST = route({}, async ({ req, actor }) => {
  const d = await body(req, input);
  const hits = await findDuplicates(prisma, d, d.excludeId);
  // Branch users learn that a duplicate exists but not the details of out-of-scope records.
  if (actor.role === 'BRANCH_USER') return { hits: hits.map((h) => ({ key: h.key, severity: h.severity, value: h.value })) };
  return { hits };
});
