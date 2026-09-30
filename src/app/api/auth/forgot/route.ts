import { z } from 'zod';
import { publicRoute, body, clientIp } from '@/server/http';
import { requestPasswordReset } from '@/server/auth/session';

export const POST = publicRoute(async ({ req }) => {
  const d = await body(req, z.object({ email: z.string().trim().email('Enter a valid email address') }));
  await requestPasswordReset(d.email, { ip: clientIp(req) });
  return { ok: true, message: 'If an account exists for that address, a reset link has been sent.' };
});
