import { NextResponse, type NextRequest } from 'next/server';
import { cookies, headers } from 'next/headers';
import type { Role } from '@prisma/client';
import { z, ZodError } from 'zod';
import { AppError, badRequest, forbidden, toAppError, unauthorized } from '@/lib/errors';
import { DEFAULT_PAGE_SIZE } from '@/lib/paging';
import type { Actor } from './actor';
import { actorFromToken, SESSION_COOKIE } from './auth/session';
import { audit } from './audit';
import { prisma } from '@/lib/db';

/**
 * The client's IP, for rate limiting and the audit log. Forwarding headers are only
 * trusted behind a proxy you run: TRUST_PROXY_HOPS=1 for one reverse proxy (the entry
 * that proxy appended is used, never the client-supplied leftmost one). With the
 * default 0 the headers are ignored, because any client can forge them.
 */
export function ipFromHeaders(h: Headers): string | null {
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!(hops > 0)) return null;
  const chain = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain.length >= hops ? chain[chain.length - hops] : null;
}

export const clientIp = (req: Request) => ipFromHeaders(req.headers);

export async function actorFromRequest(req: NextRequest | Request): Promise<Actor | null> {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return actorFromToken(m?.[1], { ip: clientIp(req), userAgent: req.headers.get('user-agent') });
}

/** For server components. */
export async function currentActor(): Promise<Actor | null> {
  const c = await cookies();
  const h = await headers();
  return actorFromToken(c.get(SESSION_COOKIE)?.value, { ip: ipFromHeaders(h), userAgent: h.get('user-agent') });
}

type Ctx<P> = { req: NextRequest; actor: Actor; params: P; url: URL };
type PublicCtx<P> = { req: NextRequest; actor: Actor | null; params: P; url: URL };

interface Opts {
  roles?: Role[];
}

function errorResponse(e: unknown) {
  if (e instanceof ZodError) {
    const details = e.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: details.map((d) => `${d.field ? d.field + ': ' : ''}${d.message}`).join('; '), details } }, { status: 400 });
  }
  const err = toAppError(e);
  if (err.status >= 500) console.error('[api] unhandled error', e);
  return NextResponse.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
}

/** CSRF defence for cookie-authenticated mutations: require a same-origin request. */
function checkOrigin(req: NextRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.get('origin');
  if (!origin) return; // non-browser clients (tests, curl) do not send Origin; cookies are SameSite=Lax
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    if (new URL(origin).host !== host) throw forbidden('Cross-origin request rejected.');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw forbidden('Cross-origin request rejected.');
  }
}

type RouteParams<P> = { params: Promise<P> };

/** Authenticated API route with role check, validation errors and consistent error bodies. */
export function route<P = Record<string, string>>(opts: Opts, fn: (ctx: Ctx<P>) => Promise<unknown>) {
  return async (req: NextRequest, rp: RouteParams<P>) => {
    try {
      checkOrigin(req);
      const actor = await actorFromRequest(req);
      if (!actor) throw unauthorized('Your session has expired or you are not signed in.');
      if (opts.roles && !opts.roles.includes(actor.role)) {
        await audit(prisma, actor, { action: 'ACCESS_DENIED', entityType: 'Route', entityLabel: `${req.method} ${new URL(req.url).pathname}` });
        throw forbidden();
      }
      const params = (rp?.params ? await rp.params : {}) as P;
      const out = await fn({ req, actor, params, url: new URL(req.url) });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function publicRoute<P = Record<string, string>>(fn: (ctx: PublicCtx<P>) => Promise<unknown>) {
  return async (req: NextRequest, rp: RouteParams<P>) => {
    try {
      checkOrigin(req);
      const params = (rp?.params ? await rp.params : {}) as P;
      const out = await fn({ req, actor: null, params, url: new URL(req.url) });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
  return schema.parse(raw);
}

/** Parse query params: page, pageSize (default DEFAULT_PAGE_SIZE), sort, dir. */
export function paging(url: URL, defaults: { sort?: string } = {}) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get('pageSize') ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE));
  const sort = url.searchParams.get('sort') ?? defaults.sort;
  const dir: 'asc' | 'desc' = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, sort, dir };
}

export const q = (url: URL, k: string) => {
  const v = url.searchParams.get(k);
  return v === null || v === '' ? undefined : v;
};
export const qList = (url: URL, k: string) => {
  const all = url.searchParams.getAll(k).flatMap((v) => v.split(',')).filter(Boolean);
  return all.length ? all : undefined;
};
