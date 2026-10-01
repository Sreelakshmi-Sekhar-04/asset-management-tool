/**
 * Concurrency check for NFR-03 / TC-NFR-04: many signed-in sessions working at once
 * across list, search, lookup, dashboard, inbox and transfer receipt, over real HTTP.
 * DEVELOPMENT / STAGING ONLY: it raises and receives real transfers in the target system.
 *
 *   BASE_URL=http://localhost:3000 LOAD_TEST_PASSWORD=… DATABASE_URL=… \
 *     npm run load:test -- --sessions 50 --seconds 60
 *
 * Users and test assets are read from DATABASE_URL (the same database the app uses).
 * The app must run with TRUST_PROXY_HOPS=1 so each virtual user gets its own client IP
 * (otherwise the per-IP sign-in limit would throttle the test's own logins).
 * Exits non-zero on any error or when p95 latency exceeds the NFR-02 limits.
 */
import { prisma } from '@/lib/db';

const arg = (name: string, def: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.LOAD_TEST_PASSWORD;
if (!PASSWORD) throw new Error('Set LOAD_TEST_PASSWORD to the password of the accounts being used.');
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run a load test with NODE_ENV=production.');

type Sample = { name: string; ms: number; ok: boolean; status: number };
const samples: Sample[] = [];
const errors: string[] = [];

async function req(name: string, path: string, s: Session, init: RequestInit = {}) {
  const t = performance.now();
  let status = 0;
  try {
    const r = await fetch(BASE + path, { ...init, headers: { cookie: s.cookie, 'x-forwarded-for': s.ip, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
    status = r.status;
    const body = await r.text();
    const ok = r.ok;
    samples.push({ name, ms: performance.now() - t, ok, status });
    if (!ok) errors.push(`${name} ${status}: ${body.slice(0, 200)}`);
    return ok ? (JSON.parse(body || '{}') as Record<string, unknown>) : null;
  } catch (e) {
    samples.push({ name, ms: performance.now() - t, ok: false, status });
    errors.push(`${name}: ${(e as Error).message}`);
    return null;
  }
}

interface Session { email: string; role: string; cookie: string; ip: string; scope: string | null }

async function signIn(email: string, role: string, scope: string | null, n: number): Promise<Session> {
  const ip = `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`;
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!r.ok) throw new Error(`Sign-in failed for ${email}: ${r.status} ${await r.text()}`);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  return { email, role, cookie, ip, scope };
}

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

async function main() {
  const sessionsWanted = arg('sessions', 50), seconds = arg('seconds', 60);
  const users = await prisma.user.findMany({ where: { active: true, passwordHash: { not: null } }, select: { email: true, role: true, location: { select: { idPath: true } } }, orderBy: { email: 'asc' } });
  const branch = users.filter((u) => u.role === 'BRANCH_USER'), it = users.filter((u) => u.role !== 'BRANCH_USER');
  if (!branch.length || !it.length) throw new Error('Need at least one branch user and one IT/Admin user.');
  // Each session searches and looks up assets inside its own scope, as a real user would.
  const termCache = new Map<string, { hostname: string | null; assetCode: string; serialNumber: string | null }[]>();
  const termsFor = async (scope: string | null) => {
    const k = scope ?? '*';
    if (!termCache.has(k)) termCache.set(k, await prisma.asset.findMany({ where: { hostname: { not: null }, ...(scope ? { location: { idPath: { startsWith: scope } } } : {}) }, select: { hostname: true, assetCode: true, serialNumber: true }, take: 200 }));
    return termCache.get(k)!;
  };
  const branches = await prisma.location.findMany({ where: { type: 'BRANCH', active: true }, select: { id: true } });

  // About 70% branch sessions and 30% IT sessions, spread over the available accounts.
  const plan = Array.from({ length: sessionsWanted }, (_, i) => (i % 10 < 7 ? branch[i % branch.length] : it[i % it.length]));
  const sessions: Session[] = [];
  for (let i = 0; i < plan.length; i++) sessions.push(await signIn(plan[i].email, plan[i].role, plan[i].location?.idPath ?? null, i));
  console.log(`${sessions.length} sessions signed in (${sessions.filter((s) => s.role === 'BRANCH_USER').length} branch, ${sessions.filter((s) => s.role !== 'BRANCH_USER').length} IT/Admin). Running for ${seconds}s against ${BASE}…`);

  const end = Date.now() + seconds * 1000;
  let receipts = 0, heldForApproval = 0;
  const vu = async (s: Session) => {
    const terms = await termsFor(s.scope);
    if (!terms.length) throw new Error(`No assets in scope for ${s.email}`);
    while (Date.now() < end) {
      const t = pick(terms);
      await req('asset list', `/api/assets?page=${1 + Math.floor(Math.random() * 20)}&pageSize=50`, s);
      await req('search', `/api/assets?search=${encodeURIComponent(pick([t.hostname!, t.serialNumber ?? t.assetCode, 'Latitude']))}`, s);
      await req('lookup', `/api/assets/lookup?q=${t.assetCode}`, s);
      await req('dashboard', '/api/dashboard', s);
      await req('inbox', '/api/transfers/inbox', s);
      if (s.role !== 'BRANCH_USER') {
        // Raise a one-asset transfer (IT-raised: auto-approved) and receive it on behalf of the branch.
        const free = await prisma.asset.findFirst({ where: { status: 'IN_STOCK', transferLines: { none: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'IN_TRANSIT'] } } } }, select: { id: true, locationId: true }, skip: Math.floor(Math.random() * 500) });
        const to = free && pick(branches.filter((b) => b.id !== free.locationId));
        if (free && to) {
          const tr = await req('transfer submit', '/api/transfers', s, { method: 'POST', body: JSON.stringify({ fromLocationId: free.locationId, toLocationId: to.id, reason: 'Load test', assetIds: [free.id] }) });
          const id = (tr?.transfer as { id?: string } | undefined)?.id;
          if (tr?.pendingApproval) heldForApproval++; // a seeded policy (e.g. inter-state, high value) applies
          else if (id) {
            const r = await req('receipt', `/api/transfers/${id}/receive`, s, { method: 'POST', body: JSON.stringify({ receivedByName: 'Load test', all: 'RECEIVED' }) });
            if (r) receipts++;
          }
        }
      }
    }
  };
  await Promise.all(sessions.map(vu));

  const by = new Map<string, number[]>();
  for (const x of samples) by.set(x.name, [...(by.get(x.name) ?? []), x.ms]);
  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
  const LIMIT: Record<string, number> = { 'asset list': 1000, search: 1000, lookup: 1000, dashboard: 2000, inbox: 1000, 'transfer submit': 3000, receipt: 3000 };
  let missed = 0;
  console.log(`\n${'request'.padEnd(16)} ${'count'.padStart(6)} ${'p50 ms'.padStart(7)} ${'p95 ms'.padStart(7)} ${'max ms'.padStart(7)}  limit`);
  for (const [name, a] of by) {
    const p95 = pct(a, 0.95);
    if (p95 > (LIMIT[name] ?? 1000)) missed++;
    console.log(`${name.padEnd(16)} ${String(a.length).padStart(6)} ${String(pct(a, 0.5)).padStart(7)} ${String(p95).padStart(7)} ${String(Math.round(Math.max(...a))).padStart(7)}  ${p95 <= (LIMIT[name] ?? 1000) ? 'PASS' : 'FAIL'} (p95 ≤ ${LIMIT[name] ?? 1000})`);
  }
  // Correct refusals caused by the test's own concurrency: two sessions grabbing the same asset
  // (the open-transfer lock rejects the second), or a lookup of an asset another session just moved out of scope.
  const expected = (e: string) => /^transfer submit (409|400): .*(open transfer|failed validation)/.test(e) || /^lookup 404/.test(e);
  const contention = errors.filter(expected).length;
  const failed = errors.length - contention;
  console.log(`\n${samples.length} requests, ${failed} unexpected errors, ${contention} expected refusals from contention, ${receipts} receipts processed, ${heldForApproval} transfers held by approval policies, ${(samples.length / seconds).toFixed(1)} req/s.`);
  if (failed) {
    const kinds = new Map<string, number>();
    for (const e of errors.filter((x) => !expected(x))) { const k = e.replace(/[A-Z]{3}-\d+|[a-z0-9]{20,}/g, '…').slice(0, 140); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
    console.log('Errors by kind:\n  ' + [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${n} × ${k}`).join('\n  '));
  }
  process.exitCode = failed || missed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
