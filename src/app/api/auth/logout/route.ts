import { NextResponse } from 'next/server';
import { publicRoute, actorFromRequest } from '@/server/http';
import { logout, SESSION_COOKIE } from '@/server/auth/session';

export const POST = publicRoute(async ({ req }) => {
  const actor = await actorFromRequest(req);
  if (actor) await logout(actor);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
});
