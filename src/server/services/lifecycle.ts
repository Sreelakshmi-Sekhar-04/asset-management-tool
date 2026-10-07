import { z } from 'zod';
import type { ApprovalAction, Asset, Prisma } from '@prisma/client';
import { prisma, tx, type Db } from '@/lib/db';
import { badRequest, conflict, forbidden } from '@/lib/errors';
import { DISPOSAL_LABEL, STATUS_LABEL } from '@/lib/labels';
import type { Actor } from '../actor';
import { audit, auditMany } from '../audit';
import { assetScope, getScopedAsset } from '../scope';
import { orgOfLocation } from '../org';
import { createApprovalRequest, findPolicy, matchContextForAssets } from './approvals';
import { assertNotRetired, assertUnlocked, holderColumns, holderName, holderOf, recordMovement, switchAssignment, validateHolder, type HolderRef } from './movement';
import { assetWhere, type AssetFilters } from './assets';

type Pending = { pendingApproval: { id: string; requestNo: string; policy: string } };
interface ExecOpts { approvalId?: string; approverName?: string }

async function gate(t: Db, actor: Actor, action: ApprovalAction, assets: Asset[], summary: string, payload: Record<string, unknown>): Promise<Pending | null> {
  const ctx = await matchContextForAssets(t, assets.map((a) => a.id), actor.role);
  const policy = await findPolicy(t, action, ctx);
  if (!policy) return null;
  const req = await createApprovalRequest(t, actor, {
    action, policy, summary, entityType: 'Asset', entityId: assets.length === 1 ? assets[0].id : undefined,
    assetIds: assets.map((a) => a.id), locationIds: [...new Set(assets.map((a) => a.locationId).filter((x): x is string => !!x))],
    payload: payload as Prisma.InputJsonValue, link: `/approvals`,
  });
  await auditMany(t, actor, assets.map((a) => ({ action: 'APPROVAL_REQUESTED', entityType: 'Asset', entityId: a.id, entityLabel: a.assetCode, details: { requestNo: req.requestNo, action }, locationIds: [a.locationId] })));
  return { pendingApproval: { id: req.id, requestNo: req.requestNo, policy: policy.name } };
}

// ───────────── Assign (FR-ASG-01, 05; FR-TRF-17) ─────────────

export const holderInput = z.object({ type: z.enum(['EMPLOYEE', 'DEPARTMENT', 'LOCATION']), id: z.string().min(1) });
export const assignInput = z.object({ holder: holderInput, remarks: z.string().trim().max(1000).optional().nullable() });

export async function assignAsset(actor: Actor, assetId: string, input: unknown) {
  const data = assignInput.parse(input);
  // Assigning to a location IS a transfer (§3): same action, same entry point, no second workflow.
  if (data.holder.type === 'LOCATION') return bulkAssign(actor, { assetIds: [assetId], holder: data.holder, remarks: data.remarks });
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, assetId, t);
    await preAssign(t, actor, asset, data.holder);
    const g = await gate(t, actor, 'ASSIGN', [asset], `Assign ${asset.assetCode} to ${await holderName(t, data.holder.type, data.holder.id)}`, { op: 'assign', assetId: asset.id, ...data });
    if (g) return g;
    return { asset: await execAssign(t, actor, asset, data.holder, data.remarks ?? null) };
  });
}

async function preAssign(t: Db, actor: Actor, asset: Asset, holder: HolderRef, opts: ExecOpts = {}) {
  assertNotRetired(asset);
  if (asset.status === 'UNDER_REPAIR') throw conflict(`Asset ${asset.assetCode} is under repair and cannot be assigned. Complete the repair first.`);
  if (asset.status !== 'IN_STOCK' && asset.status !== 'ASSIGNED') throw conflict(`Asset ${asset.assetCode} must be In stock to be assigned.`);
  await assertUnlocked(t, [asset], opts.approvalId);
  await validateHolder(t, actor, holder, await orgOfLocation(t, asset.locationId));
  const cur = holderOf(asset);
  if (cur && cur.type === holder.type && cur.id === holder.id) throw conflict(`Asset ${asset.assetCode} is already assigned to that holder.`);
}

export async function execAssign(t: Db, actor: Actor, asset: Asset, holder: HolderRef, remarks: string | null, opts: ExecOpts = {}) {
  if (opts.approvalId) await preAssign(t, actor, asset, holder, opts);
  const updated = await t.asset.update({ where: { id: asset.id }, data: { status: 'ASSIGNED', ...holderColumns(holder), updatedById: actor.id } });
  await switchAssignment(t, actor, asset.id, holder, opts.approvalId ? 'APPROVAL' : 'MANUAL');
  await recordMovement(t, actor, 'ASSIGNED', asset, { id: asset.id, status: 'ASSIGNED', locationId: asset.locationId, holder }, { remarks, approverName: opts.approverName });
  await audit(t, actor, { action: asset.status === 'ASSIGNED' ? 'ASSET_REASSIGNED' : 'ASSET_ASSIGNED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: { status: asset.status, holder: holderOf(asset) }, after: { status: 'ASSIGNED', holder, holderName: await holderName(t, holder.type, holder.id) }, details: { remarks, approvedBy: opts.approverName }, locationIds: [asset.locationId] });
  return updated;
}

// ───────────── Check-in (FR-ASG-02) ─────────────

export const checkInInput = z.object({ condition: z.string().trim().max(120).optional().nullable(), remarks: z.string().trim().max(1000).optional().nullable() });

export async function checkInAsset(actor: Actor, assetId: string, input: unknown) {
  const data = checkInInput.parse(input ?? {});
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, assetId, t);
    await preCheckIn(t, asset);
    const g = await gate(t, actor, 'CHECK_IN', [asset], `Check in ${asset.assetCode}`, { op: 'checkin', assetId: asset.id, ...data });
    if (g) return g;
    return { asset: await execCheckIn(t, actor, asset, data) };
  });
}

async function preCheckIn(t: Db, asset: Asset, opts: ExecOpts = {}) {
  assertNotRetired(asset);
  if (asset.status !== 'ASSIGNED') throw conflict(`Asset ${asset.assetCode} is ${STATUS_LABEL[asset.status]}; only Assigned assets can be checked in.`);
  await assertUnlocked(t, [asset], opts.approvalId);
}

export async function execCheckIn(t: Db, actor: Actor, asset: Asset, data: z.infer<typeof checkInInput>, opts: ExecOpts = {}) {
  if (opts.approvalId) await preCheckIn(t, asset, opts);
  const updated = await t.asset.update({ where: { id: asset.id }, data: { status: 'IN_STOCK', ...holderColumns(null), condition: data.condition ?? asset.condition, updatedById: actor.id } });
  await switchAssignment(t, actor, asset.id, null);
  await recordMovement(t, actor, 'CHECKED_IN', asset, { id: asset.id, status: 'IN_STOCK', locationId: asset.locationId, holder: null }, { remarks: data.remarks, condition: data.condition, approverName: opts.approverName });
  await audit(t, actor, { action: 'ASSET_CHECKED_IN', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: { status: asset.status, holder: holderOf(asset) }, after: { status: 'IN_STOCK', holder: null, condition: data.condition }, details: { remarks: data.remarks }, locationIds: [asset.locationId] });
  return updated;
}

// ───────────── Repair (FR-STA-02, 05) ─────────────

export const repairInput = z.object({ reason: z.string().trim().min(1, 'A reason is mandatory for repair').max(1000) });
export const repairDoneInput = z.object({ remarks: z.string().trim().max(1000).optional().nullable(), condition: z.string().trim().max(120).optional().nullable() });

function preRepair(asset: Asset) {
  assertNotRetired(asset);
  if (asset.status !== 'IN_STOCK' && asset.status !== 'ASSIGNED') throw conflict(`Asset ${asset.assetCode} is ${STATUS_LABEL[asset.status]} and cannot be sent for repair.`);
}
function preRepairDone(asset: Asset) {
  assertNotRetired(asset);
  if (asset.status !== 'UNDER_REPAIR') throw conflict(`Asset ${asset.assetCode} is not under repair.`);
}

export async function startRepair(actor: Actor, assetId: string, input: unknown) {
  const data = repairInput.parse(input);
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, assetId, t);
    preRepair(asset);
    await assertUnlocked(t, [asset]);
    const g = await gate(t, actor, 'STATUS_CHANGE', [asset], `Send ${asset.assetCode} for repair`, { op: 'repair', assetIds: [asset.id], ...data });
    if (g) return g;
    return { asset: await execRepair(t, actor, asset, data.reason) };
  });
}

export async function execRepair(t: Db, actor: Actor, asset: Asset, reason: string, opts: ExecOpts = {}) {
  if (opts.approvalId) { preRepair(asset); await assertUnlocked(t, [asset], opts.approvalId); }
  const updated = await t.asset.update({ where: { id: asset.id }, data: { status: 'UNDER_REPAIR', preRepairStatus: asset.status, updatedById: actor.id } });
  await recordMovement(t, actor, 'REPAIR_STARTED', asset, { id: asset.id, status: 'UNDER_REPAIR', locationId: asset.locationId, holder: holderOf(asset) }, { reason, approverName: opts.approverName });
  await audit(t, actor, { action: 'ASSET_STATUS_CHANGED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: { status: asset.status }, after: { status: 'UNDER_REPAIR' }, details: { reason }, locationIds: [asset.locationId] });
  return updated;
}

export async function completeRepair(actor: Actor, assetId: string, input: unknown) {
  const data = repairDoneInput.parse(input ?? {});
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, assetId, t);
    preRepairDone(asset);
    await assertUnlocked(t, [asset]);
    const g = await gate(t, actor, 'STATUS_CHANGE', [asset], `Complete repair of ${asset.assetCode}`, { op: 'repairDone', assetIds: [asset.id], ...data });
    if (g) return g;
    return { asset: await execRepairDone(t, actor, asset, data) };
  });
}

export async function execRepairDone(t: Db, actor: Actor, asset: Asset, data: z.infer<typeof repairDoneInput>, opts: ExecOpts = {}) {
  if (opts.approvalId) { preRepairDone(asset); await assertUnlocked(t, [asset], opts.approvalId); }
  // Returns to its prior state: Assigned if it has a holder, otherwise In stock.
  const status = asset.holderType ? 'ASSIGNED' : 'IN_STOCK';
  const updated = await t.asset.update({ where: { id: asset.id }, data: { status, preRepairStatus: null, condition: data.condition ?? asset.condition, updatedById: actor.id } });
  await recordMovement(t, actor, 'REPAIR_COMPLETED', asset, { id: asset.id, status, locationId: asset.locationId, holder: holderOf(asset) }, { remarks: data.remarks, condition: data.condition, approverName: opts.approverName });
  await audit(t, actor, { action: 'ASSET_STATUS_CHANGED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: { status: asset.status }, after: { status }, details: { remarks: data.remarks, repairCompleted: true }, locationIds: [asset.locationId] });
  return updated;
}

// ───────────── Retire (FR-REG-04, FR-STA-05) ─────────────

export const retireInput = z.object({
  reason: z.string().trim().min(1, 'A reason is mandatory for retirement').max(1000),
  disposalType: z.enum(['SCRAPPED', 'SOLD', 'DONATED', 'LOST']),
});

async function preRetire(t: Db, asset: Asset, opts: ExecOpts = {}) {
  assertNotRetired(asset);
  if (asset.status === 'ASSIGNED' || asset.holderType) {
    const who = await holderName(t, asset.holderType, asset.holderEmployeeId ?? asset.holderDepartmentId ?? asset.holderLocationId);
    throw conflict(`Asset ${asset.assetCode} cannot be retired while assigned to ${who}. Check it in first.`);
  }
  if (asset.status !== 'IN_STOCK') throw conflict(`Asset ${asset.assetCode} is ${STATUS_LABEL[asset.status]}; only In-stock assets can be retired.`);
  await assertUnlocked(t, [asset], opts.approvalId);
}

export async function retireAsset(actor: Actor, assetId: string, input: unknown) {
  if (actor.role === 'BRANCH_USER') {
    await audit(prisma, actor, { action: 'ACCESS_DENIED', entityType: 'Asset', entityId: assetId, details: { attempted: 'retire' } });
    throw forbidden('Branch users cannot retire assets.');
  }
  const data = retireInput.parse(input);
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, assetId, t);
    await preRetire(t, asset);
    const g = await gate(t, actor, 'RETIRE', [asset], `Retire ${asset.assetCode} (${DISPOSAL_LABEL[data.disposalType]})`, { op: 'retire', assetIds: [asset.id], ...data });
    if (g) return g;
    return { asset: await execRetire(t, actor, asset, data) };
  });
}

export async function execRetire(t: Db, actor: Actor, asset: Asset, data: z.infer<typeof retireInput>, opts: ExecOpts = {}) {
  if (opts.approvalId) await preRetire(t, asset, opts);
  const updated = await t.asset.update({ where: { id: asset.id }, data: { status: 'RETIRED', retiredAt: new Date(), retiredById: actor.id === 'system' ? null : actor.id, retireReason: data.reason, disposalType: data.disposalType, updatedById: actor.id === 'system' ? null : actor.id } });
  await t.renewable.updateMany({ where: { assetId: asset.id, status: 'ACTIVE' }, data: { status: 'CANCELLED' } });
  await recordMovement(t, actor, 'RETIRED', asset, { id: asset.id, status: 'RETIRED', locationId: asset.locationId, holder: null }, { reason: `${DISPOSAL_LABEL[data.disposalType]}: ${data.reason}`, approverName: opts.approverName });
  await audit(t, actor, { action: 'ASSET_RETIRED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: { status: asset.status }, after: { status: 'RETIRED', disposalType: data.disposalType }, details: { reason: data.reason, approvedBy: opts.approverName }, locationIds: [asset.locationId] });
  return updated;
}

// ───────────── Bulk status change (FR-STA-03) — all or nothing ─────────────

export const bulkStatusInput = z.object({
  op: z.enum(['REPAIR', 'REPAIR_DONE', 'RETIRE']),
  assetIds: z.array(z.string()).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  excludeIds: z.array(z.string()).optional(),
  reason: z.string().trim().max(1000).optional(),
  disposalType: z.enum(['SCRAPPED', 'SOLD', 'DONATED', 'LOST']).optional(),
  remarks: z.string().trim().max(1000).optional(),
});

export async function resolveSelection(t: Db, actor: Actor, sel: { assetIds?: string[]; filter?: Record<string, unknown>; excludeIds?: string[] }) {
  if (sel.assetIds?.length) {
    const rows = await t.asset.findMany({ where: { AND: [assetScope(actor), { id: { in: sel.assetIds } }] } });
    if (rows.length !== new Set(sel.assetIds).size) throw badRequest('Some selected assets were not found or are outside your scope.');
    return rows;
  }
  if (sel.filter) {
    const where = await assetWhere(actor, { ...(sel.filter as AssetFilters), excludeIds: sel.excludeIds });
    return t.asset.findMany({ where, take: 20_001 });
  }
  throw badRequest('Select at least one asset.');
}

export async function bulkStatusChange(actor: Actor, input: unknown) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Bulk status changes are an IT function.');
  const data = bulkStatusInput.parse(input);
  if ((data.op === 'REPAIR' || data.op === 'RETIRE') && !data.reason) throw badRequest('A reason is mandatory.', [{ field: 'reason', message: 'Required' }]);
  if (data.op === 'RETIRE' && !data.disposalType) throw badRequest('Choose a disposal type.');
  return tx(async (t) => {
    const assets = await resolveSelection(t, actor, data);
    if (!assets.length) throw badRequest('No assets selected.');
    if (assets.length > 20_000) throw badRequest('At most 20,000 assets can be changed at once.');
    const problems: { ref: string; message: string }[] = [];
    for (const a of assets) {
      try {
        if (data.op === 'REPAIR') preRepair(a);
        else if (data.op === 'REPAIR_DONE') preRepairDone(a);
        else await preRetireNoLock(t, a);
      } catch (e) { problems.push({ ref: a.assetCode, message: (e as Error).message }); }
    }
    try { await assertUnlocked(t, assets); } catch (e) {
      const det = ((e as { details?: { ref?: string; message: string }[] }).details ?? []);
      for (const d of det) problems.push({ ref: d.ref ?? '', message: d.message });
    }
    if (problems.length) throw badRequest(`${problems.length} of ${assets.length} selected asset(s) cannot be changed. Nothing was applied.`, problems.slice(0, 500));
    const action: ApprovalAction = data.op === 'RETIRE' ? 'RETIRE' : 'STATUS_CHANGE';
    const payload = { op: data.op === 'REPAIR' ? 'repair' : data.op === 'REPAIR_DONE' ? 'repairDone' : 'retire', assetIds: assets.map((a) => a.id), reason: data.reason, disposalType: data.disposalType, remarks: data.remarks };
    const g = await gate(t, actor, action, assets, `${data.op === 'RETIRE' ? 'Retire' : data.op === 'REPAIR' ? 'Send for repair' : 'Complete repair of'} ${assets.length} asset(s)`, payload);
    if (g) return g;
    await execBulk(t, actor, payload as BulkPayload, assets);
    return { changed: assets.length };
  }, { timeoutMs: 300_000 });
}

async function preRetireNoLock(t: Db, a: Asset) {
  assertNotRetired(a);
  if (a.status !== 'IN_STOCK') {
    const who = a.holderType ? await holderName(t, a.holderType, a.holderEmployeeId ?? a.holderDepartmentId ?? a.holderLocationId) : null;
    throw conflict(who ? `Asset ${a.assetCode} cannot be retired while assigned to ${who}.` : `Asset ${a.assetCode} is ${STATUS_LABEL[a.status]}; only In-stock assets can be retired.`);
  }
}

export interface BulkPayload { op: 'repair' | 'repairDone' | 'retire'; assetIds: string[]; reason?: string; disposalType?: 'SCRAPPED' | 'SOLD' | 'DONATED' | 'LOST'; remarks?: string }

export async function execBulk(t: Db, actor: Actor, p: BulkPayload, assets?: Asset[], opts: ExecOpts = {}) {
  const list = assets ?? (await t.asset.findMany({ where: { id: { in: p.assetIds } } }));
  for (const a of list) {
    if (p.op === 'repair') await execRepair(t, actor, a, p.reason!, opts);
    else if (p.op === 'repairDone') await execRepairDone(t, actor, a, { remarks: p.remarks }, opts);
    else await execRetire(t, actor, a, { reason: p.reason!, disposalType: p.disposalType! }, opts);
  }
}

// ───────────── Bulk check-in / reassign (offboarding FR-EMP-03) ─────────────

export async function bulkCheckIn(actor: Actor, assetIds: string[], data: { condition?: string; remarks?: string }) {
  return tx(async (t) => {
    const assets = await resolveSelection(t, actor, { assetIds });
    const problems: { ref: string; message: string }[] = [];
    for (const a of assets) {
      try { await preCheckIn(t, a); } catch (e) { problems.push({ ref: a.assetCode, message: (e as Error).message }); }
    }
    if (problems.length) throw badRequest(`${problems.length} asset(s) cannot be checked in. Nothing was applied.`, problems);
    // Bulk actions go through the same approval policies as single ones.
    const g = await gate(t, actor, 'CHECK_IN', assets, `Check in ${assets.length} asset(s)`, { op: 'checkin', assetIds: assets.map((a) => a.id), ...data });
    if (g) return g;
    for (const a of assets) await execCheckIn(t, actor, a, data);
    return { checkedIn: assets.length };
  }, { timeoutMs: 120_000 });
}

export async function bulkReassign(actor: Actor, assetIds: string[], toEmployeeId: string, remarks: string) {
  return tx(async (t) => {
    const assets = await resolveSelection(t, actor, { assetIds });
    const holder: HolderRef = { type: 'EMPLOYEE', id: toEmployeeId };
    const problems: { ref: string; message: string }[] = [];
    for (const a of assets) {
      try { await preAssign(t, actor, a, holder); } catch (e) { problems.push({ ref: a.assetCode, message: (e as Error).message }); }
    }
    if (problems.length) throw badRequest(`${problems.length} asset(s) cannot be reassigned. Nothing was applied.`, problems);
    const g = await gate(t, actor, 'ASSIGN', assets, `Reassign ${assets.length} asset(s) to ${await holderName(t, holder.type, holder.id)}`, { op: 'assign', assetIds: assets.map((a) => a.id), holder, remarks });
    if (g) return g;
    for (const a of assets) await execAssign(t, actor, a, holder, remarks);
    return { reassigned: assets.length };
  }, { timeoutMs: 120_000 });
}

// ───────────── Transfer: assign to a location (§2, §3) ─────────────

/**
 * Moving an asset to another location is a transfer. It starts from the same Assign action as an
 * assignment to an employee, but it only takes effect once an Administrator and then the
 * destination's manager have approved it (requestTransfer below). On approval the asset's
 * location becomes the destination; a holder that cannot travel with it (an employee or a
 * department) is released; a location holder follows the asset. Every change is recorded as a
 * movement and an audit entry, so the asset's history and audit trail stay complete.
 */
async function preTransfer(t: Db, actor: Actor, asset: Asset, to: { id: string; namePath: string }, opts: ExecOpts = {}) {
  assertNotRetired(asset);
  if (asset.status === 'UNDER_REPAIR') throw conflict(`Asset ${asset.assetCode} is under repair and cannot be transferred. Complete the repair first.`);
  if (asset.locationId === to.id) throw conflict(`Asset ${asset.assetCode} is already at ${to.namePath}.`);
  await assertUnlocked(t, [asset], opts.approvalId);
  // Cross-organization moves are refused in the service layer, whatever the UI offered (§19).
  await validateHolder(t, actor, { type: 'LOCATION', id: to.id }, await orgOfLocation(t, asset.locationId));
}

export async function execTransfer(t: Db, actor: Actor, asset: Asset, toLocationId: string, remarks: string | null, opts: ExecOpts = {}) {
  const to = await t.location.findUniqueOrThrow({ where: { id: toLocationId }, select: { id: true, namePath: true } });
  if (opts.approvalId) await preTransfer(t, actor, asset, to, opts);
  const cur = holderOf(asset);
  const holderTravels = cur?.type === 'LOCATION';
  const nextHolder: HolderRef | null = holderTravels ? { type: 'LOCATION', id: to.id } : null;
  const updated = await t.asset.update({
    where: { id: asset.id },
    data: {
      locationId: to.id,
      ...holderColumns(nextHolder),
      status: nextHolder ? 'ASSIGNED' : 'IN_STOCK',
      updatedById: actor.id === 'system' ? null : actor.id,
    },
  });
  await switchAssignment(t, actor, asset.id, nextHolder, opts.approvalId ? 'APPROVAL' : 'MANUAL');
  await recordMovement(t, actor, 'TRANSFERRED', asset, { id: asset.id, status: updated.status, locationId: to.id, holder: nextHolder }, {
    remarks, approverName: opts.approverName,
    reason: cur && !holderTravels ? `Transferred to ${to.namePath}; released from ${await holderName(t, cur.type, cur.id)}` : `Transferred to ${to.namePath}`,
  });
  await audit(t, actor, {
    action: 'ASSET_TRANSFERRED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode,
    before: { locationId: asset.locationId, status: asset.status, holder: cur },
    after: { locationId: to.id, location: to.namePath, status: updated.status, holder: nextHolder },
    details: { remarks, approvedBy: opts.approverName, releasedHolder: cur && !holderTravels ? await holderName(t, cur.type, cur.id) : null },
    locationIds: [asset.locationId, to.id],
  });
  return updated;
}

// ───────────── Assign / transfer from the asset register (one or many assets) ─────────────

export const bulkAssignInput = z.object({
  assetIds: z.array(z.string()).max(2000).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  excludeIds: z.array(z.string()).optional(),
  holder: holderInput,
  remarks: z.string().trim().max(1000).optional().nullable(),
  /** Check only: report what would be assigned, skipped or refused, and change nothing. */
  dryRun: z.boolean().optional(),
});

type BulkAssignProblem = { ref: string; message: string };

/**
 * One action behind the asset register's Assign button, for one asset or for many.
 *   • an employee (or a department) holder  → the assets are assigned to them (Assign policies apply);
 *   • a location                           → a transfer request, which needs an Administrator's and
 *                                            then the destination manager's approval before anything moves.
 * Everything happens in a single transaction with the same checks for one asset or many. Assets that are already there are skipped; assets
 * that cannot move (retired, under repair, locked by an approval …) are listed and left
 * untouched while the rest go through.
 */
export async function bulkAssign(actor: Actor, input: unknown) {
  const data = bulkAssignInput.parse(input);
  return tx(async (t) => {
    const assets = await resolveSelection(t, actor, data);
    if (!assets.length) throw badRequest('No assets selected.');
    if (assets.length > 2000) throw badRequest('At most 2,000 assets can be assigned at once.');
    const holder: HolderRef = data.holder;
    const isTransfer = holder.type === 'LOCATION';
    const assetOrgIds = [...new Set(await Promise.all(assets.map((a) => orgOfLocation(t, a.locationId))))];
    await validateHolder(t, actor, holder, assetOrgIds.length === 1 ? assetOrgIds[0] : null);
    const name = (await holderName(t, holder.type, holder.id))!;
    const to = isTransfer ? await t.location.findUniqueOrThrow({ where: { id: holder.id }, select: { id: true, namePath: true } }) : null;
    const skipped: BulkAssignProblem[] = [];
    const failed: BulkAssignProblem[] = [];
    const ok: Asset[] = [];
    for (const a of [...assets].sort((x, y) => x.assetCode.localeCompare(y.assetCode))) {
      if (isTransfer && a.locationId === to!.id) { skipped.push({ ref: a.assetCode, message: `Already at ${name}` }); continue; }
      const cur = holderOf(a);
      if (!isTransfer && cur && cur.type === holder.type && cur.id === holder.id && a.status === 'ASSIGNED') { skipped.push({ ref: a.assetCode, message: `Already assigned to ${name}` }); continue; }
      try {
        if (isTransfer) await preTransfer(t, actor, a, to!);
        else await preAssign(t, actor, a, holder);
        ok.push(a);
      } catch (e) { failed.push({ ref: a.assetCode, message: (e as Error).message }); }
    }
    const verb = isTransfer ? 'transferred' : 'assigned';
    const released = isTransfer ? ok.filter((a) => { const h = holderOf(a); return h && h.type !== 'LOCATION'; }).length : 0;
    // Every transfer waits for two approvals; the check step names who gives them.
    const manager = isTransfer && ok.length ? await locationManager(t, to!.id) : null;
    const approvals = manager ? ['Admin manager: any Administrator', `Location manager: ${manager.name} (${manager.locationName})`] : undefined;
    const result = { mode: isTransfer ? ('TRANSFER' as const) : ('ASSIGN' as const), holder: name, selected: assets.length, skipped, failed, released, approvals };
    if (data.dryRun) return { ...result, assignable: ok.length, assigned: 0 };
    if (!ok.length) throw badRequest(`None of the ${assets.length} selected asset(s) can be ${verb} to ${name}. Nothing was changed.`, [...failed, ...skipped]);
    if (isTransfer) return { ...result, assignable: ok.length, assigned: 0, ...(await requestTransfer(t, actor, ok, to!, manager!, data.remarks ?? null)) };
    const payload = { op: 'assign', assetIds: ok.map((a) => a.id), holder, remarks: data.remarks ?? null };
    const g = await gate(t, actor, 'ASSIGN', ok, `Assign ${ok.length} asset(s) to ${name}`, payload);
    if (g) return { ...result, assignable: ok.length, assigned: 0, ...g };
    for (const a of ok) await execAssign(t, actor, a, holder, data.remarks ?? null);
    return { ...result, assignable: ok.length, assigned: ok.length };
  }, { timeoutMs: 120_000 });
}

// ───────────── Transfer approval: Administrator, then the destination's manager ─────────────

/**
 * The manager who approves transfers into a location: the location's own manager, else the
 * nearest ancestor's (a region's, or the organization's). Without one the transfer cannot be
 * requested, because nobody could give the second approval.
 */
export async function locationManager(db: Db, locationId: string) {
  const loc = await db.location.findUniqueOrThrow({ where: { id: locationId }, select: { idPath: true, namePath: true } });
  const ids = loc.idPath.split('/').filter(Boolean).reverse();
  const chain = await db.location.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, manager: { select: { id: true, name: true, active: true } } } });
  const byId = new Map(chain.map((l) => [l.id, l]));
  for (const id of ids) {
    const l = byId.get(id);
    if (l?.manager?.active) return { userId: l.manager.id, name: l.manager.name, locationName: l.name };
  }
  throw conflict(`${loc.namePath} has no location manager to approve transfers into it. Set one under Configuration → Locations.`);
}

/**
 * Raises the transfer request. Nothing moves yet: the assets stay where they are, marked
 * "Pending admin approval", until an Administrator and then the destination's manager approve.
 * There is no approval policy to match and no automatic approval.
 */
async function requestTransfer(t: Db, actor: Actor, assets: Asset[], to: { id: string; namePath: string }, manager: { userId: string }, remarks: string | null): Promise<Pending> {
  const req = await createApprovalRequest(t, actor, {
    action: 'TRANSFER', policy: null, defaultPolicyName: 'Transfer approval',
    defaultSteps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'ADMIN' }, { stepOrder: 2, approverType: 'USER', approverUserId: manager.userId }],
    summary: `Transfer ${assets.length} asset${assets.length === 1 ? '' : 's'} to ${to.namePath}`,
    entityType: 'Asset', entityId: assets.length === 1 ? assets[0].id : undefined, assetIds: assets.map((a) => a.id),
    locationIds: [...new Set([...assets.map((a) => a.locationId).filter((x): x is string => !!x), to.id])],
    payload: { op: 'transfer', assetIds: assets.map((a) => a.id), toLocationId: to.id, remarks }, link: '/approvals',
  });
  await t.asset.updateMany({ where: { id: { in: assets.map((a) => a.id) } }, data: { transferStatus: 'PENDING_ADMIN', transferRequestId: req.id } });
  await auditMany(t, actor, assets.map((a) => ({ action: 'APPROVAL_REQUESTED', entityType: 'Asset', entityId: a.id, entityLabel: a.assetCode, details: { requestNo: req.requestNo, action: 'TRANSFER', to: to.namePath, remarks }, locationIds: [a.locationId, to.id] })));
  return { pendingApproval: { id: req.id, requestNo: req.requestNo, policy: req.policyName } };
}
