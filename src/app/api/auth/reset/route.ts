import { z } from 'zod';
import { publicRoute, body } from '@/server/http';
import { completePasswordReset } from '@/server/auth/session';

export const POST = publicRoute(async ({ req }) => {
  const d = await body(req, z.object({ token: z.string().min(10), password: z.string().min(1).max(200) }));
  await completePasswordReset(d.token, d.password);
  return { ok: true };
});
