import type { Asset, AssetStatus, HolderType, MovementKind, Prisma } from '@prisma/client';
import type { Db } from '@/lib/db';
import { badRequest, conflict, forbidden } from '@/lib/errors';
import type { Actor } from '../actor';
import { inScopePath } from '../scope';

export interface HolderRef {
  type: HolderType;
  id: string;
}

export async function holderName(db: Db, type: HolderType | null | undefined, id: string | null | undefined): Promise<string | null> {
  if (!type || !id) return null;
  if (type === 'EMPLOYEE') {
    const e = await db.employee.findUnique({ where: { id }, select: { name: true, employeeCode: true } });
    return e ? `${e.name} (${e.employeeCode})` : null;
  }
  if (type === 'DEPARTMENT') return (await db.department.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
  return (await db.location.findUnique({ where: { id }, select: { namePath: true } }))?.namePath ?? null;
}

export function holderOf(a: Pick<Asset, 'holderType' | 'holderEmployeeId' | 'holderDepartmentId' | 'holderLocationId'>): HolderRef | null {
  if (!a.holderType) return null;
  const id = a.holderType === 'EMPLOYEE' ? a.holderEmployeeId : a.holderType === 'DEPARTMENT' ? a.holderDepartmentId : a.holderLocationId;
  return id ? { type: a.holderType, id } : null;
}

export function holderColumns(h: HolderRef | null) {
  return {
    holderType: h?.type ?? null,
    holderEmployeeId: h?.type === 'EMPLOYEE' ? h.id : null,
    holderDepartmentId: h?.type === 'DEPARTMENT' ? h.id : null,
    holderLocationId: h?.type === 'LOCATION' ? h.id : null,
  };
}

/** Validate a holder exists, is active, and (for branch users) is within scope. */
export async function validateHolder(db: Db, actor: Actor, h: HolderRef) {
  if (h.type === 'EMPLOYEE') {
    const e = await db.employee.findUnique({ where: { id: h.id }, include: { location: true } });
    if (!e) throw badRequest('The selected employee does not exist.');
    if (!e.active) throw badRequest(`${e.name} is inactive and cannot be assigned assets.`);
    if (actor.role === 'BRANCH_USER' && !inScopePath(actor, e.location?.idPath)) throw forbidden('Branch users can only assign to employees of their own branch.');
    return `${e.name} (${e.employeeCode})`;
  }
  if (h.type === 'DEPARTMENT') {
    const d = await db.department.findUnique({ where: { id: h.id } });
    if (!d || !d.active) throw badRequest('The selected department does not exist or is inactive.');
    return d.name;
  }
  const l = await db.location.findUnique({ where: { id: h.id } });
  if (!l || !l.active) throw badRequest('The selected location does not exist or is inactive.');
  if (actor.role === 'BRANCH_USER' && !inScopePath(actor, l.idPath)) throw forbidden('Branch users can only assign within their own branch.');
  return l.namePath;
}

/** INV-4 and pending approvals: throw a specific error naming what locks the asset(s). */
export async function assertUnlocked(db: Db, assets: { id: string; assetCode: string }[], ignoreApprovalId?: string) {
  if (!assets.length) return;
  const ids = assets.map((a) => a.id);
  const code = new Map(assets.map((a) => [a.id, a.assetCode]));
  const lines = await db.transferLine.findMany({
    where: { assetId: { in: ids }, status: { in: ['PENDING_APPROVAL', 'IN_TRANSIT'] } },
    select: { assetId: true, transfer: { select: { transferNo: true, status: true } } },
  });
  if (lines.length) {
    const details = lines.map((l) => ({ ref: code.get(l.assetId), message: `Asset ${code.get(l.assetId)} is part of open transfer ${l.transfer.transferNo}.` }));
    throw conflict(lines.length === 1 ? `${details[0].message.replace('is part of', 'cannot be changed because it is part of')}` : `${lines.length} assets are locked by open transfers.`, details);
  }
  const pending = await db.approvalRequest.findMany({
    where: { status: 'PENDING', assetIds: { hasSome: ids }, ...(ignoreApprovalId ? { id: { not: ignoreApprovalId } } : {}) },
    select: { requestNo: true, assetIds: true, action: true },
  });
  if (pending.length) {
    const details = pending.flatMap((p) => p.assetIds.filter((i) => code.has(i)).map((i) => ({ ref: code.get(i), message: `Asset ${code.get(i)} has a pending approval request ${p.requestNo}.` })));
    throw conflict(details.length === 1 ? details[0].message : `${details.length} assets have pending approval requests.`, details);
  }
}

export function assertNotRetired(a: Pick<Asset, 'status' | 'assetCode'>) {
  if (a.status === 'RETIRED') throw conflict(`Asset ${a.assetCode} is retired and cannot be changed.`);
}

export interface MovementExtra {
  effectiveAt?: Date;
  reason?: string | null;
  remarks?: string | null;
  condition?: string | null;
  transferId?: string | null;
  transferLineId?: string | null;
  approverName?: string | null;
  receivedByName?: string | null;
  isCorrection?: boolean;
}

export async function recordMovement(
  db: Db,
  actor: Actor,
  kind: MovementKind,
  before: Pick<Asset, 'id' | 'status' | 'locationId' | 'holderType' | 'holderEmployeeId' | 'holderDepartmentId' | 'holderLocationId'> | null,
  after: { id: string; status: AssetStatus; locationId: string | null; holder: HolderRef | null },
  extra: MovementExtra = {},
) {
  const bh = before ? holderOf(before) : null;
  const locName = async (id: string | null | undefined) => (id ? (await db.location.findUnique({ where: { id }, select: { namePath: true } }))?.namePath ?? null : null);
  const data: Prisma.AssetMovementUncheckedCreateInput = {
    assetId: after.id,
    kind,
    fromLocationId: before?.locationId ?? null,
    fromLocationName: await locName(before?.locationId),
    toLocationId: after.locationId,
    toLocationName: await locName(after.locationId),
    fromHolderType: bh?.type ?? null,
    fromHolderId: bh?.id ?? null,
    fromHolderName: await holderName(db, bh?.type, bh?.id),
    toHolderType: after.holder?.type ?? null,
    toHolderId: after.holder?.id ?? null,
    toHolderName: await holderName(db, after.holder?.type, after.holder?.id),
    fromStatus: before?.status ?? null,
    toStatus: after.status,
    effectiveAt: extra.effectiveAt ?? new Date(),
    actorId: actor.id === 'system' ? null : actor.id,
    actorName: actor.name,
    transferId: extra.transferId ?? null,
    transferLineId: extra.transferLineId ?? null,
    approverName: extra.approverName ?? null,
    receivedByName: extra.receivedByName ?? null,
    reason: extra.reason ?? null,
    remarks: extra.remarks ?? null,
    condition: extra.condition ?? null,
    isCorrection: extra.isCorrection ?? false,
  };
  return db.assetMovement.create({ data });
}

/** Open/close holder periods for the assignment history (FR-ASG-04). */
export async function switchAssignment(db: Db, actor: Actor, assetId: string, next: HolderRef | null, source = 'MANUAL', at = new Date()) {
  await db.assetAssignment.updateMany({ where: { assetId, endAt: null }, data: { endAt: at, endedById: actor.id === 'system' ? null : actor.id } });
  if (next) {
    await db.assetAssignment.create({
      data: { assetId, holderType: next.type, holderId: next.id, holderName: (await holderName(db, next.type, next.id)) ?? next.id, startAt: at, assignedById: actor.id === 'system' ? null : actor.id, source },
    });
  }
}
