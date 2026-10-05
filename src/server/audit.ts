import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import type { Actor } from './actor';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  details?: unknown;
  before?: unknown;
  after?: unknown;
  locationIds?: (string | null | undefined)[];
}

const REDACT = /password|secret|token|apikey|api_key|hash/i;
function redact(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(redact);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = REDACT.test(k) ? '[redacted]' : redact(x);
    }
    return out;
  }
  if (typeof v === 'bigint') return v.toString();
  return v;
}
const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(redact(v) ?? null)) as Prisma.InputJsonValue));

function row(actor: Actor | null, a: AuditInput): Prisma.AuditLogCreateManyInput {
  return {
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    actorRole: actor?.role ?? null,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId ?? null,
    entityLabel: a.entityLabel ?? null,
    details: json(a.details),
    before: json(a.before),
    after: json(a.after),
    locationIds: (a.locationIds ?? []).filter((x): x is string => !!x),
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent?.slice(0, 300) ?? null,
  };
}

/** Append an audit entry. Pass the transaction client so the entry commits atomically with the change. */
export async function audit(db: Db, actor: Actor | null, a: AuditInput) {
  await db.auditLog.create({ data: row(actor, a) });
}

export async function auditMany(db: Db, actor: Actor | null, entries: AuditInput[]) {
  if (!entries.length) return;
  for (let i = 0; i < entries.length; i += 2000) {
    await db.auditLog.createMany({ data: entries.slice(i, i + 2000).map((e) => row(actor, e)) });
  }
}

/** Compute a before/after diff of the changed keys only. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const bv = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k]?.toString?.() ?? before[k] ?? null;
    const av = after[k] instanceof Date ? (after[k] as Date).toISOString() : (after[k] as { toString?: () => string })?.toString?.() ?? after[k] ?? null;
    if (bv !== av) {
      b[k] = bv;
      a[k] = av;
    }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}

export { prisma as auditDb };
