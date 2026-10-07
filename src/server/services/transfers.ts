import type { Prisma, TransferStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { dateOnly, fmtDateOnly } from '@/lib/format';
import type { Actor } from '../actor';
import { inScopePath, transferScope } from '../scope';

/**
 * Transfer HISTORY only.
 *
 * Assignment and transfer are both done from the asset register (see `bulkAssign` and
 * `execTransfer` in lifecycle.ts): a move to another location is recorded as a TRANSFERRED
 * movement on the asset, in one action. There is no separate transfer workflow, and no new
 * Transfer rows are created.
 *
 * The transfers raised by the old workflow are kept exactly as they were, and these queries
 * read them for the asset's history, the audit trail and the transfer-history reports (§5).
 */

// ───────────── Queries ─────────────

export interface TransferFilters { status?: string[]; direction?: 'inbound' | 'outbound'; fromLocationId?: string; toLocationId?: string; search?: string; transferNo?: string; reason?: string; dateFrom?: string; dateTo?: string; interState?: boolean; requestedById?: string }

export async function transferWhere(actor: Actor, f: TransferFilters): Promise<Prisma.TransferWhereInput> {
  const and: Prisma.TransferWhereInput[] = [transferScope(actor)];
  if (f.status?.length) and.push({ status: { in: f.status as TransferStatus[] } });
  if (f.direction && actor.role === 'BRANCH_USER') and.push(f.direction === 'inbound' ? { toLocation: { idPath: { startsWith: actor.scopeIdPath! } } } : { fromLocation: { idPath: { startsWith: actor.scopeIdPath! } } });
  for (const [k, rel] of [[f.fromLocationId, 'fromLocation'], [f.toLocationId, 'toLocation']] as const) {
    if (!k) continue;
    const loc = await prisma.location.findUnique({ where: { id: k }, select: { idPath: true } });
    and.push({ [rel]: { idPath: { startsWith: loc?.idPath ?? '/__none__/' } } });
  }
  if (f.search) and.push({ OR: [{ transferNo: { contains: f.search, mode: 'insensitive' } }, { reason: { contains: f.search, mode: 'insensitive' } }, { lines: { some: { assetCode: { equals: f.search.toUpperCase() } } } }] });
  if (f.transferNo?.trim()) {
    const t = f.transferNo.trim();
    and.push({ OR: [{ transferNo: { contains: t, mode: 'insensitive' } }, { lines: { some: { assetCode: { equals: t.toUpperCase() } } } }] });
  }
  if (f.reason?.trim()) and.push({ reason: { contains: f.reason.trim(), mode: 'insensitive' } });
  if (f.dateFrom) and.push({ requestedAt: { gte: dateOnly(f.dateFrom) } });
  if (f.dateTo) and.push({ requestedAt: { lt: new Date(dateOnly(f.dateTo).getTime() + 86_400_000) } });
  if (f.interState !== undefined) and.push({ interState: f.interState });
  if (f.requestedById) and.push({ requestedById: f.requestedById });
  return { AND: and };
}

export async function lineCounts(ids: string[]) {
  const rows = await prisma.transferLine.groupBy({ by: ['transferId', 'status'], where: { transferId: { in: ids } }, _count: true });
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) { const o = m.get(r.transferId) ?? {}; o[r.status] = r._count; m.set(r.transferId, o); }
  return (id: string) => {
    const c = m.get(id) ?? {};
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const received = c.RECEIVED ?? 0, rejected = c.NOT_RECEIVED ?? 0, recalled = c.RECALLED ?? 0;
    const pending = (c.IN_TRANSIT ?? 0) + (c.PENDING_APPROVAL ?? 0) + (c.DRAFT ?? 0);
    return { total, received, rejected, recalled, pending, resolved: received + rejected + recalled };
  };
}

export async function listTransfers(actor: Actor, f: TransferFilters, p: { skip: number; take: number; sort?: string; dir?: 'asc' | 'desc' }) {
  const where = await transferWhere(actor, f);
  const sorts: Record<string, Prisma.TransferOrderByWithRelationInput> = { transferNo: { transferNo: p.dir ?? 'desc' }, requestedAt: { requestedAt: p.dir ?? 'desc' }, status: { status: p.dir ?? 'asc' }, lineCount: { lineCount: p.dir ?? 'desc' }, approvedAt: { approvedAt: p.dir ?? 'desc' } };
  const [rows, total] = await Promise.all([
    prisma.transfer.findMany({ where, include: { fromLocation: { select: { namePath: true, idPath: true } }, toLocation: { select: { namePath: true, idPath: true } } }, orderBy: [sorts[p.sort ?? ''] ?? { requestedAt: 'desc' }, { id: 'asc' }], skip: p.skip, take: p.take }),
    prisma.transfer.count({ where }),
  ]);
  const counts = await lineCounts(rows.map((r) => r.id));
  const now = Date.now();
  return {
    rows: rows.map((r) => ({
      id: r.id, transferNo: r.transferNo, from: r.fromLocation.namePath, to: r.toLocation.namePath, reason: r.reason, status: r.status,
      requestedBy: r.requestedByName, requestedAt: r.requestedAt, effectiveDate: r.effectiveDate, approvedAt: r.approvedAt, approver: r.approverNames,
      completedAt: r.completedAt, interState: r.interState, recordedLate: r.recordedLate, counts: counts(r.id),
      daysInTransit: r.approvedAt && (r.status === 'IN_TRANSIT' || r.status === 'PARTIALLY_RECEIVED') ? Math.floor((now - r.approvedAt.getTime()) / 86_400_000) : null,
      direction: actor.role === 'BRANCH_USER' ? (inScopePath(actor, r.toLocation.idPath) ? 'inbound' : 'outbound') : null,
    })),
    total,
  };
}

/** Historical "not received" lines, for the transfer-exceptions report and the asset's flags. */
export async function listExceptions(actor: Actor, p: { status?: string; skip: number; take: number }) {
  const where: Prisma.TransferExceptionWhereInput = {
    ...(p.status === 'OPEN' || p.status === 'RESOLVED' ? { status: p.status } : {}),
    line: { transfer: transferScope(actor) },
  };
  const [rows, total] = await Promise.all([
    prisma.transferException.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take,
      include: { line: { select: { assetCode: true, serialNumber: true, make: true, model: true, receivedByName: true, transfer: { select: { id: true, transferNo: true, fromLocation: { select: { namePath: true } }, toLocation: { select: { namePath: true } }, requestedByName: true } } } } },
    }),
    prisma.transferException.count({ where }),
  ]);
  const now = Date.now();
  return { rows: rows.map((r) => ({ ...r, daysOpen: Math.floor(((r.resolvedAt?.getTime() ?? now) - r.createdAt.getTime()) / 86_400_000), owner: 'IT' })), total };
}

export { fmtDateOnly };
