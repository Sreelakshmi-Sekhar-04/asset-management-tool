'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ApiErrorDetail { field?: string; line?: string | number; ref?: string; message: string }
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: ApiErrorDetail[] | unknown) { super(message); }
  get list(): ApiErrorDetail[] { return Array.isArray(this.details) ? (this.details as ApiErrorDetail[]) : []; }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
    headers: opts.form ? undefined : opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/auth/')) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}&expired=1`;
    throw new ApiError(401, 'UNAUTHORIZED', 'Your session has expired.');
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    if (ct.includes('application/json')) {
      const j = await res.json();
      throw new ApiError(res.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? res.statusText, j?.error?.details);
    }
    throw new ApiError(res.status, 'ERROR', res.statusText);
  }
  // A change to master data invalidates the shared lists, so the next screen sees it.
  if ((opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET')) !== 'GET') {
    for (const p of ['/api/locations', '/api/categories', '/api/departments']) if (path.startsWith(p)) clearCachedApi(p);
  }
  return (ct.includes('application/json') ? res.json() : res.blob()) as Promise<T>;
}

/** POST/GET that returns a file, then triggers a browser download. */
export async function download(path: string, body?: unknown) {
  const res = await fetch(path, { method: body !== undefined ? 'POST' : 'GET', headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiError(res.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? res.statusText, j?.error?.details);
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = decodeURIComponent(name);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/**
 * POST that returns a PDF, opened in a new tab so the browser's viewer gives a print
 * preview and Print / Save buttons. Falls back to a download if pop-ups are blocked.
 */
export async function openFile(path: string, body?: unknown) {
  const win = window.open('', '_blank');
  try {
    const res = await fetch(path, { method: body !== undefined ? 'POST' : 'GET', headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new ApiError(res.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? res.statusText, j?.error?.details);
    }
    const url = URL.createObjectURL(await res.blob());
    if (win) { win.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60_000); return; }
    const a = document.createElement('a');
    a.href = url; a.download = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'labels.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

/**
 * Master data (locations, categories, departments) that several screens need and that changes
 * rarely. It is fetched once per browser tab and reused, so moving between screens does not
 * re-request the same lists; in-flight requests for the same path are shared. The cache is
 * dropped when the organization changes (the page reloads) or when the data is edited.
 */
const CACHE_MS = 2 * 60_000;
const cache = new Map<string, { at: number; data: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

export function clearCachedApi(prefix?: string) {
  for (const k of [...cache.keys()]) if (!prefix || k.startsWith(prefix)) cache.delete(k);
}

async function cachedGet<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data as T;
  const pending = inFlight.get(path);
  if (pending) return pending as Promise<T>;
  const p = api<T>(path).then((d) => { cache.set(path, { at: Date.now(), data: d }); return d; }).finally(() => inFlight.delete(path));
  inFlight.set(path, p as Promise<unknown>);
  return p;
}

/** Like useApi, for the shared master-data lists above. */
export function useCachedApi<T = unknown>(path: string) {
  const [data, setData] = useState<T | null>(() => {
    const hit = cache.get(path);
    return hit && Date.now() - hit.at < CACHE_MS ? (hit.data as T) : null;
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!data);
  const load = useCallback(async (force = false) => {
    if (force) clearCachedApi(path.split('?')[0]);
    setLoading(true);
    try {
      const d = await cachedGet<T>(path);
      setData(d); setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
    } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: () => load(true), setData };
}

export function useApi<T = unknown>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function qs(params: Record<string, string | number | boolean | string[] | undefined | null>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => x && u.append(k, x));
    else u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}
