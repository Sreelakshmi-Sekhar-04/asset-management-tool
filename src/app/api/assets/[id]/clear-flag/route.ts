import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { clearDuplicateFlag, clearFlag } from '@/server/services/assets';

const input = z.object({ flag: z.enum(['MISSING', 'TRANSFER_EXCEPTION', 'DUPLICATE_SUSPECT']), reason: z.string().trim().min(1, 'A reason is required').max(1000) });
export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => {
  const d = await body(req, input);
  return d.flag === 'DUPLICATE_SUSPECT' ? clearDuplicateFlag(actor, params.id, d.reason) : clearFlag(actor, params.id, d.flag, d.reason);
});
