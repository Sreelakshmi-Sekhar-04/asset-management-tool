import { z } from 'zod';
import { route, body } from '@/server/http';
import { changePassword } from '@/server/auth/session';

export const POST = route({}, async ({ req, actor }) => {
  const d = await body(req, z.object({ current: z.string().min(1), next: z.string().min(1).max(200) }));
  await changePassword(actor, d.current, d.next);
  return { ok: true };
});
