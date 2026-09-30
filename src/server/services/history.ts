import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { badRequest, notFound } from '@/lib/errors';
import { fmtDateOnly } from '@/lib/format';
import { MOVEMENT_LABEL, STATUS_LABEL } from '@/lib/labels';
import type { Actor } from '../actor';
import { getScopedAsset, inScopePath } from '../scope';

export interface TimelineItem { at: Date; effectiveAt?: Date | null; kind: string; title: string; actor: string | null; details: string[]; ref?: { type: string; id: string; label: string } }

const MOVEMENT_AUDITS = new Set(['ASSET_CREATED', 'ASSET_ASSIGNED', 'ASSET_REASSIGNED', 'ASSET_CHECKED_IN', 'ASSET_STATUS_CHANGED', 'ASSET_RETIRED', 'ASSET_CORRECTED', 'TRANSFER_LINE_RECEIVED', 'TRANSFER_LINE_REJECTED']);

const AUDIT_TITLE: Record<string, string> = {
  ASSET_UPDATED: 'Details edited', APPROVAL_REQUESTED: 'Approval requested', DUPLICATE_FLAG_CLEARED: 'Duplicate flag cleared', ASSET_FLAG_CLEARED: 'Flag cleared',
  VERIFICATION_DISCREPANCY_ACCEPTED: 'Verification discrepancy accepted', VERIFICATION_DISCREPANCY_REJECTED: 'Verification discrepancy rejected',
  TRANSFER_LINE_RECALLED: 'Transfer line recalled', TRANSFER_EXCEPTION_RESOLVED: 'Transfer exception resolved', ASSET_ID_CHANGE_REJECTED: 'Attempt to change Asset ID rejected',
  ACCESS_DENIED: 'Access denied',
};

function fmtVal(v: unknown) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDateOnly(v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** FR-REG-02 / FR-AUD-04: the human-readable view of the audit + movement history. */
export async function assetTimeline(actor: Actor, idOrCode: string): Promise<TimelineItem[]> {
  const asset = await getScopedAsset(actor, idOrCode);
  const [movements, audits, lines] = await Promise.all([
    prisma.assetMovement.findMany({ where: { assetId: asset.id }, orderBy: [{ recordedAt: 'asc' }] }),
    prisma.auditLog.findMany({ where: { entityType: 'Asset', entityId: asset.id }, orderBy: { at: 'asc' } }),
    prisma.transferLine.findMany({ where: { assetId: asset.id }, select: { transferId: true } }),
  ]);
  const transferIds = [...new Set(lines.map((l) => l.transferId))];
  const transferAudits = transferIds.length
    ? await prisma.auditLog.findMany({ where: { entityType: 'Transfer', entityId: { in: transferIds }, action: { in: ['TRANSFER_CREATED', 'TRANSFER_SUBMITTED', 'TRANSFER_APPROVED', 'TRANSFER_AUTO_APPROVED', 'TRANSFER_REJECTED', 'TRANSFER_CANCELLED', 'TRANSFER_RECALLED'] } }, orderBy: { at: 'asc' } })
    : [];
  const items: TimelineItem[] = [];
  for (const m of movements) {
    const d: string[] = [];
    let title = MOVEMENT_LABEL[m.kind];
    if (m.kind === 'REGISTERED' || m.kind === 'IMPORTED') { title = m.kind === 'IMPORTED' ? 'Asset imported' : 'Asset created'; if (m.toLocationName) d.push(`Location: ${m.toLocationName}`); }
    else if (m.kind === 'ASSIGNED') { title = `Assigned to ${m.toHolderName}`; if (m.fromHolderName) d.push(`Previous holder: ${m.fromHolderName}`); }
    else if (m.kind === 'CHECKED_IN') { title = `Checked in from ${m.fromHolderName ?? '—'}`; if (m.condition) d.push(`Condition: ${m.condition}`); }
    else if (m.kind === 'TRANSFER_RECEIVED') { title = `Received at ${m.toLocationName}`; d.push(`From: ${m.fromLocationName}`); if (m.approverName) d.push(`Approved by: ${m.approverName}`); if (m.receivedByName) d.push(`Received by: ${m.receivedByName}`); }
    else if (m.kind === 'TRANSFER_NOT_RECEIVED') { title = `Not received at destination — remains at ${m.fromLocationName}`; if (m.receivedByName) d.push(`Recorded by: ${m.receivedByName}`); }
    else if (m.kind === 'REPAIR_STARTED' || m.kind === 'REPAIR_COMPLETED' || m.kind === 'RETIRED') { if (m.toStatus) d.push(`Status: ${STATUS_LABEL[m.fromStatus ?? ''] ?? '—'} → ${STATUS_LABEL[m.toStatus]}`); }
    else if (m.kind === 'CORRECTION') { title = 'Correction (location/holder)'; d.push(`Location: ${m.fromLocationName ?? '—'} → ${m.toLocationName ?? '—'}`, `Holder: ${m.fromHolderName ?? '—'} → ${m.toHolderName ?? '—'}`); }
    if (m.reason) d.push(`Reason: ${m.reason}`);
    if (m.remarks) d.push(`Remarks: ${m.remarks}`);
    if (m.kind !== 'TRANSFER_RECEIVED' && m.approverName) d.push(`Approved by: ${m.approverName}`);
    if (m.effectiveAt.getTime() < m.recordedAt.getTime() - 86_400_000) d.push(`Effective ${fmtDateOnly(m.effectiveAt)} · recorded late`);
    items.push({ at: m.recordedAt, effectiveAt: m.effectiveAt, kind: m.kind, title, actor: m.actorName, details: d, ref: m.transferId ? { type: 'transfer', id: m.transferId, label: '' } : undefined });
  }
  for (const a of audits) {
    if (MOVEMENT_AUDITS.has(a.action)) continue;
    const d: string[] = [];
    const before = (a.before ?? {}) as Record<string, unknown>;
    const after = (a.after ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(after)) d.push(`${k}: ${fmtVal(before[k])} → ${fmtVal(after[k])}`);
    const det = (a.details ?? {}) as Record<string, unknown>;
    if (det.serialChangeReason) d.push(`Reason: ${det.serialChangeReason}`);
    if (det.reason) d.push(`Reason: ${det.reason}`);
    if (det.requestNo) d.push(`Request: ${det.requestNo}`);
    if (det.transferNo && a.action !== 'ASSET_UPDATED') d.push(`Transfer: ${det.transferNo}`);
    if (det.resolution) d.push(`Resolution: ${det.resolution}`);
    items.push({ at: a.at, kind: a.action, title: AUDIT_TITLE[a.action] ?? a.action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), actor: a.actorEmail, details: d });
  }
  for (const a of transferAudits) {
    const det = (a.details ?? {}) as Record<string, unknown>;
    const titles: Record<string, string> = {
      TRANSFER_CREATED: `Transfer ${a.entityLabel} created (${det.from} → ${det.to})`, TRANSFER_SUBMITTED: `Transfer ${a.entityLabel} submitted${det.approval ? ' for approval' : ''}`,
      TRANSFER_APPROVED: `Transfer ${a.entityLabel} approved — in transit`, TRANSFER_AUTO_APPROVED: `Transfer ${a.entityLabel} auto-approved — in transit`,
      TRANSFER_REJECTED: `Transfer ${a.entityLabel} rejected`, TRANSFER_CANCELLED: `Transfer ${a.entityLabel} cancelled`, TRANSFER_RECALLED: `Transfer ${a.entityLabel} recalled`,
    };
    const d: string[] = [];
    if (det.reason && a.action === 'TRANSFER_CREATED') d.push(`Reason: ${det.reason}`);
    if (det.approvers) d.push(`Approved by: ${det.approvers}`);
    if (det.comment) d.push(`Comment: ${det.comment}`);
    if (a.action === 'TRANSFER_RECALLED' && Array.isArray(det.assets) && !(det.assets as string[]).includes(asset.assetCode)) continue;
    items.push({ at: a.at, kind: a.action, title: titles[a.action], actor: a.actorEmail, details: d, ref: { type: 'transfer', id: a.entityId!, label: a.entityLabel ?? '' } });
  }
  const users = await prisma.user.findMany({ where: { email: { in: items.map((i) => i.actor).filter((x): x is string => !!x && x.includes('@')) } }, select: { email: true, name: true } });
  const nm = new Map(users.map((u) => [u.email, u.name]));
  return items.map((i) => ({ ...i, actor: i.actor ? nm.get(i.actor) ?? i.actor : null })).sort((x, y) => x.at.getTime() - y.at.getTime());
}

/** End of day D in IST as an exclusive UTC instant. */
function endOfDayIST(d: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw badRequest('Use a date in YYYY-MM-DD format.');
  return new Date(Date.parse(`${d}T00:00:00+05:30`) + 86_400_000);
}

/** FR-AUD-03: an asset's location, holder and status on date D, including in-transit state. */
export async function assetAsOf(actor: Actor, idOrCode: string, date: string) {
  const asset = await getScopedAsset(actor, idOrCode);
  const end = endOfDayIST(date);
  const m = await prisma.assetMovement.findFirst({ where: { assetId: asset.id, effectiveAt: { lt: end } }, orderBy: [{ effectiveAt: 'desc' }, { recordedAt: 'desc' }] });
  if (!m) return { assetCode: asset.assetCode, date, existed: false };
  const transit = await prisma.transferLine.findFirst({
    where: { assetId: asset.id, transfer: { approvedAt: { lt: end } }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: end } }], status: { in: ['IN_TRANSIT', 'RECEIVED', 'NOT_RECEIVED', 'RECALLED'] } },
    include: { transfer: { select: { transferNo: true, toLocation: { select: { namePath: true } }, recordedLate: true, effectiveDate: true } } },
  });
  return {
    assetCode: asset.assetCode, date, existed: true,
    location: m.toLocationName, holder: m.toHolderName, status: m.toStatus,
    inTransit: transit ? { transferNo: transit.transfer.transferNo, to: transit.transfer.toLocation.namePath } : null,
    basedOn: { kind: m.kind, effectiveAt: m.effectiveAt, recordedAt: m.recordedAt },
  };
}

/** FR-AUD-03: the assets a branch held on date D, including those in transit from it. */
export async function branchAsOf(actor: Actor, locationId: string, date: string, p: { skip: number; take: number }) {
  const loc = await prisma.location.findUnique({ where: { id: locationId } });
  if (!loc || !inScopePath(actor, loc.idPath)) throw notFound('Location');
  const end = endOfDayIST(date);
  const rows = await prisma.$queryRaw<{ assetId: string; assetCode: string; make: string; model: string; serialNumber: string | null; location: string | null; holder: string | null; status: string; transferNo: string | null; transitTo: string | null }[]>`
    WITH last AS (
      SELECT DISTINCT ON (m."assetId") m."assetId", m."toLocationId", m."toLocationName", m."toHolderName", m."toStatus"
      FROM asset_movements m
      WHERE m."effectiveAt" < ${end}
      ORDER BY m."assetId", m."effectiveAt" DESC, m."recordedAt" DESC
    )
    SELECT a.id AS "assetId", a."assetCode", a.make, a.model, a."serialNumber", last."toLocationName" AS location, last."toHolderName" AS holder, last."toStatus"::text AS status,
      tr."transferNo", tl2."namePath" AS "transitTo"
    FROM last
    JOIN assets a ON a.id = last."assetId"
    JOIN locations l ON l.id = last."toLocationId"
    LEFT JOIN LATERAL (
      SELECT t."transferNo", t."toLocationId" FROM transfer_lines tl JOIN transfers t ON t.id = tl."transferId"
      WHERE tl."assetId" = a.id AND t."approvedAt" < ${end} AND (tl."resolvedAt" IS NULL OR tl."resolvedAt" >= ${end})
        AND tl.status IN ('IN_TRANSIT','RECEIVED','NOT_RECEIVED','RECALLED')
      LIMIT 1
    ) tr ON true
    LEFT JOIN locations tl2 ON tl2.id = tr."toLocationId"
    WHERE l."idPath" LIKE ${loc.idPath + '%'} AND last."toStatus" <> 'RETIRED'
    ORDER BY a."assetCode"`;
  return { location: loc.namePath, date, total: rows.length, inTransitFrom: rows.filter((r) => r.transferNo).length, rows: rows.slice(p.skip, p.skip + p.take) };
}

export type _Unused = Prisma.AssetMovementWhereInput;
