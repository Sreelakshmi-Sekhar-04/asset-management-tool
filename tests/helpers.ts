import { NextRequest } from 'next/server';
import { login } from '@/server/auth/session';
import { PASSWORD } from './fixtures';

let ipN = 1;
/** A fresh client IP per call so the per-IP sign-in rate limit never interferes. */
export const ip = () => `10.99.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

export async function sessionCookie(email: string) {
  const { token } = await login(email, PASSWORD, { ip: ip() });
  return `itam_session=${token}`;
}

/** Call an App Router handler the way Next does, with a session cookie. */
export async function call<P>(handler: (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>, opts: { url: string; method?: string; cookie?: string; body?: unknown; params?: P; headers?: Record<string, string> }) {
  const req = new NextRequest(new URL(opts.url, 'http://localhost:3000'), {
    method: opts.method ?? 'GET',
    headers: { ...(opts.headers ?? {}), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handler(req, { params: Promise.resolve((opts.params ?? {}) as P) });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, res };
}

/** Assert a promise rejects with an AppError of the given HTTP status. */
export async function rejectsWith(p: Promise<unknown>, status: number, message?: RegExp) {
  try { await p; } catch (e) {
    const err = e as { status?: number; message: string };
    if (err.status !== status) throw new Error(`Expected status ${status}, got ${err.status}: ${err.message}`);
    if (message && !message.test(err.message)) throw new Error(`Message "${err.message}" does not match ${message}`);
    return err;
  }
  throw new Error(`Expected rejection with status ${status}, but it resolved`);
}
