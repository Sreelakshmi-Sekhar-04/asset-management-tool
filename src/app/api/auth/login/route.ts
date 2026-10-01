import { NextResponse } from 'next/server';
import { z } from 'zod';
import { publicRoute, body, clientIp } from '@/server/http';
import { login, SESSION_COOKIE } from '@/server/auth/session';

const input = z.object({ email: z.string().trim().min(1, 'Email is required').max(200), password: z.string().min(1, 'Password is required').max(200) });

export const POST = publicRoute(async ({ req }) => {
  const d = await body(req, input);
  const { token, expiresAt } = await login(d.email, d.password, { ip: clientIp(req), userAgent: req.headers.get('user-agent') });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', expires: expiresAt,
    secure: process.env.FORCE_HTTPS === 'true' || (process.env.APP_URL ?? '').startsWith('https://'),
  });
  return res;
});
