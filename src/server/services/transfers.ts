import { z } from 'zod';
import type { ApprovalRequest, Asset, Prisma, Transfer, TransferLineStatus, TransferStatus } from '@prisma/client';
import { prisma, tx, type Db } from '@/lib/db';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { dateOnly, todayIST, fmtDateOnly } from '@/lib/format';
import type { Actor } from '../actor';
import { audit, auditMany } from '../audit';
import { assetScope, inScopePath, transferScope } from '../scope';
import { branchUserIdsFor, itUserIds, notifyUsers } from '../notify';
import { canActOnTask, createApprovalRequest, findPolicy, matchContextForAssets, cancelRequest } from './approvals';
import { assetWhere, type AssetFilters } from './assets';
import { effectiveState } from './locations';
import { holderOf } from './movement';

const OPEN_LINE: TransferLineStatus[] = ['PENDING_APPROVAL', 'IN_TRANSIT'];
const optStr = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);

export const transferInput = z.object({
  fromLocationId: z.string().min(1, 'From-location is required'),
  toLocationId: z.string().min(1, 'To-location is required'),
  reason: z.string().trim().min(1, 'A reason is mandatory').max(1000),
  remarks: optStr(2000),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  linkedReference: optStr(300),
  sdpTicketId: optStr(60),
  sdpTicketUrl: optStr(500).refine((v) => !v || /^https?:\/\//i.test(v), 'Ticket URL must start with http(s)://'),
  invoiceNumber: optStr(80),
  assetIds: z.array(z.string()).max(20_000).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  excludeIds: z.array(z.string()).optional(),
  submit: z.boolean().default(true),
});

// ───────────── Selection helpers (FR-TRF-01) ─────────────

/** Resolve pasted / uploaded Asset IDs or serials. Returns found assets and the tokens that did not resolve. */
export async function resolveIdentifiers(actor: Actor, text: string, fromLocationId?: string) {
  const tokens = [...new Set(text.split(/[\s,;\t\r\n]+/).map((s) => s.trim()).filter(Boolean))].slice(0, 20_000);
  if (!tokens.length) return { found: [], unresolved: [], invalid: [] };
  const upper = tokens.map((t) => t.toUpperCase());
  const lower = tokens.map((t) => t.toLowerCase());
  const assets = await prisma.asset.findMany({
    where: { AND: [assetScope(actor), { OR: [{ assetCode: { in: upper } }, { serialNormalized: { in: lower } }, { legacyTagNormalized: { in: lower } }] }] },
    include: { location: { select: { idPath: true, namePath: true } }, transferLines: { where: { status: { in: OPEN_LINE } }, select: { transfer: { select: { transferNo: true } } } } },
  });
  const matched = new Set<string>();
  for (const a of assets) { matched.add(a.assetCode.toUpperCase()); if (a.serialNormalized) matched.add(a.serialNormalized.toUpperCase()); if (a.legacyTagNormalized) matched.add(a.legacyTagNormalized.toUpperCase()); }
  const unresolved = tokens.filter((t) => !matched.has(t.toUpperCase()));
  const from = fromLocationId ? await prisma.location.findUnique({ where: { id: fromLocationId } }) : null;
  const invalid: { assetCode: string; message: string }[] = [];
  const found = [];
  for (const a of assets) {
    const problem = lineProblem(a, from);
    if (problem) invalid.push({ assetCode: a.assetCode, message: problem });
    else found.push({ id: a.id, assetCode: a.assetCode, serialNumber: a.serialNumber, make: a.make, model: a.model, status: a.status, location: a.location?.namePath });
  }
  return { found, unresolved, invalid };
}

type AssetWithLoc = Asset & { location: { idPath: string; namePath: string } | null; transferLines: { transfer: { transferNo: string } }[] };

function lineProblem(a: AssetWithLoc, from: { idPath: string; namePath: string } | null): string | null {
  if (a.status === 'RETIRED') return `Asset ${a.assetCode} is retired and cannot be transferred.`;
  if (a.transferLines.length) return `Asset ${a.assetCode} cannot be transferred because it is already part of transfer ${a.transferLines[0].transfer.transferNo}.`;
  if (from && !(a.location?.idPath ?? '').startsWith(from.idPath)) return `Asset ${a.assetCode} is not located under ${from.namePath} (it is at ${a.location?.namePath ?? 'no location'}).`;
  return null;
}

// ───────────── Create / submit (FR-TRF-01..03) ─────────────

export async function createTransfer(actor: Actor, input: unknown, opts: { db?: Db; resendOfExceptionIds?: string[] } = {}) {
  const data = transferInput.parse(input);
  const run = async (t: Db) => {
    if (data.fromLocationId === data.toLocationId) throw badRequest('From and to locations must differ.');
    const [from, to] = await Promise.all([t.location.findUnique({ where: { id: data.fromLocationId } }), t.location.findUnique({ where: { id: data.toLocationId } })]);
    if (!from || !from.active) throw badRequest('From-location not found or inactive.');
    if (!to || !to.active) throw badRequest('To-location not found or inactive.');
    if (actor.role === 'BRANCH_USER') {
      if (!inScopePath(actor, from.idPath)) throw forbidden('A branch can raise outbound transfers only from its own location.');
      if (inScopePath(actor, to.idPath) && to.idPath.startsWith(from.idPath) && from.idPath.startsWith(actor.scopeIdPath!)) {
        /* moving within own subtree is still a location-to-location transfer (D1) */
      }
    }
    const today = todayIST();
    const eff = data.effectiveDate ?? today;
    if (eff < today && actor.role === 'BRANCH_USER') throw forbidden('Branch users cannot back-date a transfer; the effective date cannot precede today.');
    if (eff > today) throw badRequest('The effective date cannot be in the future.');
    const recordedLate = eff < today;

    // Resolve selection server-side (select-across-pages is a filter + exclusion list).
    let assets: AssetWithLoc[];
    const include = { location: { select: { idPath: true, namePath: true } }, transferLines: { where: { status: { in: OPEN_LINE } }, select: { transfer: { select: { transferNo: true } } } } };
    if (data.assetIds?.length) {
      assets = await t.asset.findMany({ where: { AND: [assetScope(actor), { id: { in: data.assetIds } }] }, include }) as AssetWithLoc[];
      const missing = data.assetIds.length - assets.length;
      if (missing > 0) throw badRequest(`${missing} selected asset(s) were not found or are outside your scope. Nothing was saved.`);
    } else if (data.filter) {
      const where = await assetWhere(actor, { ...(data.filter as AssetFilters), excludeIds: data.excludeIds });
      assets = await t.asset.findMany({ where, include, take: 20_001 }) as AssetWithLoc[];
    } else throw badRequest('Add at least one asset to the transfer.');
    if (!assets.length) throw badRequest('Add at least one asset to the transfer.');
    if (assets.length > 20_000) throw badRequest('A transfer can contain at most 20,000 assets.');

    const problems = assets.map((a) => ({ a, p: lineProblem(a, from) })).filter((x) => x.p);
    if (problems.length) {
      const notUnder = problems.filter((x) => x.p!.includes('not located under')).length;
      const headline = notUnder === problems.length ? `Transfer cannot be submitted because ${notUnder} selected asset(s) are not located under ${from.namePath}.` : `Transfer cannot be submitted: ${problems.length} line(s) failed validation. Nothing was saved.`;
      throw badRequest(headline, problems.slice(0, 1000).map((x) => ({ line: x.a.assetCode, ref: x.a.assetCode, message: x.p! })));
    }
    const pendingApprovals = await t.approvalRequest.findMany({ where: { status: 'PENDING', assetIds: { hasSome: assets.map((a) => a.id) } }, select: { requestNo: true, assetIds: true } });
    if (pendingApprovals.length) {
      const codes = new Map(assets.map((a) => [a.id, a.assetCode]));
      throw badRequest('Some assets have pending approval requests and cannot be transferred.', pendingApprovals.flatMap((r) => r.assetIds.filter((i) => codes.has(i)).map((i) => ({ ref: codes.get(i), message: `Asset ${codes.get(i)} has pending approval ${r.requestNo}.` }))));
    }

    const [sf, st] = await Promise.all([effectiveState(t, from.id), effectiveState(t, to.id)]);
    const transfer = await t.transfer.create({
      data: {
        fromLocationId: from.id, toLocationId: to.id, reason: data.reason, remarks: data.remarks, status: 'DRAFT',
        interState: !!(sf && st && sf.toLowerCase() !== st.toLowerCase()),
        requestedById: actor.id, requestedByName: actor.name, requestedByRole: actor.role, effectiveDate: dateOnly(eff), recordedLate,
        linkedReference: data.linkedReference, sdpTicketId: data.sdpTicketId, sdpTicketUrl: data.sdpTicketUrl, invoiceNumber: data.invoiceNumber,
        lineCount: assets.length, resendOfExceptionIds: opts.resendOfExceptionIds ?? [],
      },
    });
    for (let i = 0; i < assets.length; i += 5000) {
      await t.transferLine.createMany({
        data: assets.slice(i, i + 5000).map((a) => ({ transferId: transfer.id, assetId: a.id, status: 'DRAFT' as const, assetCode: a.assetCode, serialNumber: a.serialNumber, make: a.make, model: a.model, assetStatusAtDispatch: a.status })),
      });
    }
    await audit(t, actor, { action: 'TRANSFER_CREATED', entityType: 'Transfer', entityId: transfer.id, entityLabel: transfer.transferNo, details: { from: from.namePath, to: to.namePath, reason: data.reason, lines: assets.length, recordedLate, effectiveDate: eff, interState: transfer.interState }, locationIds: [from.id, to.id] });
    if (data.submit) return submitInTx(t, actor, transfer.id);
    return { transfer };
  };
  return opts.db ? run(opts.db) : tx(run, { timeoutMs: 120_000 });
}

export async function submitTransfer(actor: Actor, id: string) {
  return tx((t) => submitInTx(t, actor, id), { timeoutMs: 120_000 });
}

async function submitInTx(t: Db, actor: Actor, id: string) {
  const transfer = await t.transfer.findFirst({ where: { AND: [{ id }, transferScope(actor)] }, include: { fromLocation: true, toLocation: true } });
  if (!transfer) throw notFound('Transfer');
  if (transfer.status !== 'DRAFT') throw conflict(`${transfer.transferNo} has already been submitted.`);
  if (transfer.requestedById !== actor.id && actor.role === 'BRANCH_USER') throw forbidden('Only the raiser can submit this draft.');
  // Re-validate every line at submit time (FR-TRF-02); nothing is saved partially.
  const lines = await t.transferLine.findMany({ where: { transferId: id }, include: { asset: { include: { location: { select: { idPath: true, namePath: true } }, transferLines: { where: { status: { in: OPEN_LINE } }, select: { transfer: { select: { transferNo: true } } } } } } } });
  const problems = lines.map((l) => ({ l, p: lineProblem(l.asset as AssetWithLoc, transfer.fromLocation) })).filter((x) => x.p);
  if (problems.length) throw badRequest(`Transfer cannot be submitted: ${problems.length} line(s) failed validation. Nothing was saved.`, problems.map((x) => ({ line: x.l.assetCode, ref: x.l.assetCode, message: x.p! })));

  const assetIds = lines.map((l) => l.assetId);
  const policy = await findPolicy(t, 'TRANSFER', await matchContextForAssets(t, assetIds, actor.role, transfer.interState));
  const needsApproval = !!policy || actor.role === 'BRANCH_USER';
  try {
    await t.transferLine.updateMany({ where: { transferId: id }, data: { status: needsApproval ? 'PENDING_APPROVAL' : 'IN_TRANSIT' } });
  } catch (e) {
    if (/transfer_lines_one_open_per_asset|Unique constraint/i.test(String(e))) throw conflict('One or more assets were added to another open transfer at the same moment. Refresh and try again.');
    throw e;
  }
  const submittedAt = new Date();
  if (needsApproval) {
    const req = await createApprovalRequest(t, actor, {
      action: 'TRANSFER', policy,
      defaultPolicyName: 'Default rule: branch-raised transfers need IT approval', defaultSteps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'IT_OPERATOR' }],
      summary: `${transfer.transferNo}: ${lines.length} asset(s) ${transfer.fromLocation.name} → ${transfer.toLocation.name}`,
      entityType: 'Transfer', entityId: id, assetIds, locationIds: [transfer.fromLocationId, transfer.toLocationId],
      payload: { transferId: id }, link: `/transfers/${id}`,
    });
    const u = await t.transfer.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedAt, approvalRequestId: req.id } });
    await audit(t, actor, { action: 'TRANSFER_SUBMITTED', entityType: 'Transfer', entityId: id, entityLabel: transfer.transferNo, details: { lines: lines.length, approval: req.requestNo, policy: req.policyName }, locationIds: [transfer.fromLocationId, transfer.toLocationId] });
    return { transfer: u, pendingApproval: { id: req.id, requestNo: req.requestNo, policy: req.policyName } };
  }
  await t.transfer.update({ where: { id }, data: { submittedAt } });
  await audit(t, actor, { action: 'TRANSFER_SUBMITTED', entityType: 'Transfer', entityId: id, entityLabel: transfer.transferNo, details: { lines: lines.length, autoApproved: true }, locationIds: [transfer.fromLocationId, transfer.toLocationId] });
  const u = await dispatch(t, actor, transfer, 'Auto-approved (IT-raised)', null, true);
  return { transfer: u };
}

/** Approval → In transit: assets stay on the sender's books, locked (FR-TRF-04). */
async function dispatch(t: Db, actor: Actor, transfer: Transfer & { fromLocation: { name: string; namePath: string }; toLocation: { name: string; namePath: string } }, approverNames: string, comment: string | null, auto: boolean) {
  await t.transferLine.updateMany({ where: { transferId: transfer.id, status: { in: ['PENDING_APPROVAL', 'DRAFT'] } }, data: { status: 'IN_TRANSIT' } });
  const u = await t.transfer.update({ where: { id: transfer.id }, data: { status: 'IN_TRANSIT', approvedAt: new Date(), approverNames, approvalComment: comment, autoApproved: auto } });
  await audit(t, actor, { action: auto ? 'TRANSFER_AUTO_APPROVED' : 'TRANSFER_APPROVED', entityType: 'Transfer', entityId: transfer.id, entityLabel: transfer.transferNo, details: { approvers: approverNames, comment, status: 'IN_TRANSIT' }, locationIds: [transfer.fromLocationId, transfer.toLocationId] });
  const receivers = await branchUserIdsFor(t, transfer.toLocationId);
  await notifyUsers(t, receivers, { type: 'TRANSFER_IN_TRANSIT', title: `Inbound transfer ${transfer.transferNo} is in transit`, body: `${transfer.lineCount} asset(s) from ${transfer.fromLocation.namePath} are on their way to ${transfer.toLocation.namePath}. Confirm receipt line by line when they arrive.`, link: `/transfers/${transfer.id}/receive`, eventKey: `transfer:${transfer.id}:in-transit` });
  if (!auto) await notifyUsers(t, [transfer.requestedById], { type: 'TRANSFER_DECIDED', title: `Transfer ${transfer.transferNo} approved`, body: `Approved by ${approverNames}${comment ? `: ${comment}` : ''}. The assets are now in transit.`, link: `/transfers/${transfer.id}`, eventKey: `transfer:${transfer.id}:approved` });
  return u;
}

// Approval-engine callbacks
export async function onTransferApproved(t: Prisma.TransactionClient, decider: Actor, req: ApprovalRequest, approvers: string) {
  const transfer = await t.transfer.findUniqueOrThrow({ where: { id: req.entityId! }, include: { fromLocation: true, toLocation: true } });
  if (transfer.status !== 'PENDING_APPROVAL') throw conflict(`${transfer.transferNo} is no longer pending approval.`);
  const lastComment = (await t.approvalTask.findFirst({ where: { requestId: req.id, status: 'APPROVED' }, orderBy: { decidedAt: 'desc' } }))?.comment ?? null;
  await dispatch(t, decider, transfer, approvers, lastComment, false);
}

export async function onTransferRejected(t: Prisma.TransactionClient, actor: Actor, req: ApprovalRequest, comment: string) {
  const transfer = await t.transfer.findUniqueOrThrow({ where: { id: req.entityId! } });
  await t.transferLine.updateMany({ where: { transferId: transfer.id, status: 'PENDING_APPROVAL' }, data: { status: 'CANCELLED', resolvedAt: new Date() } });
  await t.transfer.update({ where: { id: transfer.id }, data: { status: 'REJECTED', rejectedAt: new Date(), approverNames: actor.name, approvalComment: comment } });
  await audit(t, actor, { action: 'TRANSFER_REJECTED', entityType: 'Transfer', entityId: transfer.id, entityLabel: transfer.transferNo, details: { comment }, locationIds: [transfer.fromLocationId, transfer.toLocationId] });
}

export async function onTransferCancelled(t: Prisma.TransactionClient, actor: Actor, req: ApprovalRequest) {
  const transfer = await t.transfer.findUniqueOrThrow({ where: { id: req.entityId! } });
  await t.transferLine.updateMany({ where: { transferId: transfer.id, status: { in: ['PENDING_APPROVAL', 'DRAFT'] } }, data: { status: 'CANCELLED', resolvedAt: new Date() } });
  await t.transfer.update({ where: { id: transfer.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor.id } });
  await audit(t, actor, { action: 'TRANSFER_CANCELLED', entityType: 'Transfer', entityId: transfer.id, entityLabel: transfer.transferNo, locationIds: [transfer.fromLocationId, transfer.toLocationId] });
}

// ───────────── Cancel / recall (FR-TRF-12) ─────────────

export async function cancelTransfer(actor: Actor, id: string) {
  const transfer = await prisma.transfer.findFirst({ where: { AND: [{ id }, transferScope(actor)] } });
  if (!transfer) throw notFound('Transfer');
  if (transfer.requestedById !== actor.id && actor.role !== 'ADMIN') throw forbidden('Only the raiser (or an Administrator) can cancel a transfer.');
  if (transfer.status === 'PENDING_APPROVAL' && transfer.approvalRequestId) {
    await cancelRequest(actor, transfer.approvalRequestId);
    return { ok: true };
  }
  if (transfer.status !== 'DRAFT') throw conflict(`${transfer.transferNo} is ${transfer.status.replace('_', ' ').toLowerCase()} and can no longer be cancelled. After approval, IT can recall unresolved lines.`);
  return tx(async (t) => {
    await t.transferLine.updateMany({ where: { transferId: id }, data: { status: 'CANCELLED', resolvedAt: new Date() } });
    await t.transfer.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor.id } });
    await audit(t, actor, { action: 'TRANSFER_CANCELLED', entityType: 'Transfer', entityId: id, entityLabel: transfer.transferNo, locationIds: [transfer.fromLocationId, transfer.toLocationId] });
    return { ok: true };
  });
}

export async function recallTransfer(actor: Actor, id: string, input: { reason?: string; lineIds?: string[] }) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Only IT can recall a transfer after approval.');
  if (!input.reason?.trim()) throw badRequest('A reason is required to recall.');
  return tx(async (t) => {
    await t.$queryRaw`SELECT id FROM transfers WHERE id = ${id} FOR UPDATE`;
    const transfer = await t.transfer.findUnique({ where: { id }, include: { fromLocation: true, toLocation: true } });
    if (!transfer) throw notFound('Transfer');
    if (transfer.status !== 'IN_TRANSIT' && transfer.status !== 'PARTIALLY_RECEIVED') throw conflict(`${transfer.transferNo} is not in transit.`);
    const where: Prisma.TransferLineWhereInput = { transferId: id, status: 'IN_TRANSIT', ...(input.lineIds?.length ? { id: { in: input.lineIds } } : {}) };
    const recalled = await t.transferLine.findMany({ where, select: { id: true, assetId: true, assetCode: true } });
    if (!recalled.length) throw conflict('There are no unresolved lines to recall.');
    await t.transferLine.updateMany({ where: { id: { in: recalled.map((r) => r.id) } }, data: { status: 'RECALLED', resolvedAt: new Date(), resolvedById: actor.id, remark: input.reason } });
    const header = await recomputeHeader(t, transfer.id);
    await audit(t, actor, { action: 'TRANSFER_RECALLED', entityType: 'Transfer', entityId: id, entityLabel: transfer.transferNo, details: { reason: input.reason, lines: recalled.length, assets: recalled.map((r) => r.assetCode), newStatus: header.status }, locationIds: [transfer.fromLocationId, transfer.toLocationId] });
    await auditMany(t, actor, recalled.map((r) => ({ action: 'TRANSFER_LINE_RECALLED', entityType: 'Asset', entityId: r.assetId, entityLabel: r.assetCode, details: { transferNo: transfer.transferNo, reason: input.reason }, locationIds: [transfer.fromLocationId] })));
    const recipients = [...(await branchUserIdsFor(t, transfer.fromLocationId)), ...(await branchUserIdsFor(t, transfer.toLocationId)), transfer.requestedById];
    await notifyUsers(t, recipients, { type: 'TRANSFER_RECALLED', title: `Transfer ${transfer.transferNo} recalled`, body: `${actor.name} recalled ${recalled.length} unresolved line(s): ${input.reason}. The assets remain at ${transfer.fromLocation.namePath}.`, link: `/transfers/${id}`, eventKey: `transfer:${id}:recall:${Date.now()}` });
    return { recalled: recalled.length, status: header.status };
  });
}

async function recomputeHeader(t: Db, transferId: string) {
  const counts = await t.transferLine.groupBy({ by: ['status'], where: { transferId }, _count: true });
  const c = Object.fromEntries(counts.map((x) => [x.status, x._count])) as Record<string, number>;
  const unresolved = (c.IN_TRANSIT ?? 0) + (c.PENDING_APPROVAL ?? 0);
  const resolvedWithOutcome = (c.RECEIVED ?? 0) + (c.NOT_RECEIVED ?? 0);
  const recalled = c.RECALLED ?? 0;
  let status: TransferStatus;
  if (unresolved > 0) status = resolvedWithOutcome + recalled > 0 ? 'PARTIALLY_RECEIVED' : 'IN_TRANSIT';
  else status = resolvedWithOutcome > 0 ? 'COMPLETED' : 'CANCELLED';
  return t.transfer.update({ where: { id: transferId }, data: { status, completedAt: status === 'COMPLETED' ? new Date() : undefined, cancelledAt: status === 'CANCELLED' ? new Date() : undefined } });
}

// ───────────── Receipt (FR-TRF-05..09) ─────────────

export const receiptInput = z.object({
  receivedByName: z.string().trim().min(1, '"Received by" name is required').max(120),
  remarks: optStr(1000),
  all: z.enum(['RECEIVED']).optional(),
  lines: z.array(z.object({
    lineId: z.string(),
    outcome: z.enum(['RECEIVED', 'NOT_RECEIVED']),
    reason: optStr(500),
    remark: optStr(500),
  })).max(20_000).optional(),
});

export async function receive(actor: Actor, transferId: string, input: unknown) {
  const data = receiptInput.parse(input);
  return tx(async (t) => {
    await t.$queryRaw`SELECT id FROM transfers WHERE id = ${transferId} FOR UPDATE`;
    const transfer = await t.transfer.findUnique({ where: { id: transferId }, include: { fromLocation: true, toLocation: true } });
    if (!transfer) throw notFound('Transfer');
    // BR-TRF-2: only lines addressed to the receiver's branch can be processed by that branch.
    if (actor.role === 'BRANCH_USER' && !inScopePath(actor, transfer.toLocation.idPath)) {
      await audit(t, actor, { action: 'ACCESS_DENIED', entityType: 'Transfer', entityId: transferId, entityLabel: transfer.transferNo, details: { attempted: 'receive' } });
      if (inScopePath(actor, transfer.fromLocation.idPath)) throw forbidden('Only the destination branch can confirm receipt.');
      throw notFound('Transfer');
    }
    if (transfer.status !== 'IN_TRANSIT' && transfer.status !== 'PARTIALLY_RECEIVED') throw conflict(`${transfer.transferNo} is ${transfer.status.replace(/_/g, ' ').toLowerCase()}; there is nothing to receive.`);

    let decisions: { lineId: string; outcome: 'RECEIVED' | 'NOT_RECEIVED'; reason: string | null; remark: string | null }[];
    if (data.all) {
      const open = await t.transferLine.findMany({ where: { transferId, status: 'IN_TRANSIT' }, select: { id: true } });
      decisions = open.map((l) => ({ lineId: l.id, outcome: 'RECEIVED', reason: null, remark: null }));
    } else decisions = (data.lines ?? []).map((l) => ({ lineId: l.lineId, outcome: l.outcome, reason: l.reason ?? null, remark: l.remark ?? null }));
    if (!decisions.length) throw badRequest('Select at least one line to receive or reject.');
    const missingReason = decisions.filter((d) => d.outcome === 'NOT_RECEIVED' && !d.reason);
    if (missingReason.length) throw badRequest(`A reason is required for every rejected line (${missingReason.length} missing).`, missingReason.map((d) => ({ line: d.lineId, message: 'Reason required' })));

    const lines = await t.transferLine.findMany({
      where: { id: { in: decisions.map((d) => d.lineId) }, transferId },
      include: { asset: { include: { holderEmployee: { select: { name: true, employeeCode: true } }, holderDepartment: { select: { name: true } }, holderLocation: { select: { namePath: true, idPath: true } } } } },
    });
    if (lines.length !== decisions.length) throw badRequest('Some lines do not belong to this transfer.');
    const notOpen = lines.filter((l) => l.status !== 'IN_TRANSIT');
    if (notOpen.length) throw conflict(`${notOpen.length} line(s) were already processed (for example ${notOpen[0].assetCode}, now ${notOpen[0].status.replace('_', ' ').toLowerCase()}). Refresh and continue with the remaining lines.`, notOpen.map((l) => ({ ref: l.assetCode, message: `Already ${l.status}` })));

    const receipt = await t.transferReceipt.create({ data: { transferId, actorId: actor.id, actorName: actor.name, receivedByName: data.receivedByName, remarks: data.remarks } });
    const now = new Date();
    const effectiveAt = transfer.recordedLate ? transfer.effectiveDate : now;
    const byId = new Map(decisions.map((d) => [d.lineId, d]));
    const received = lines.filter((l) => byId.get(l.id)!.outcome === 'RECEIVED');
    const rejected = lines.filter((l) => byId.get(l.id)!.outcome === 'NOT_RECEIVED');

    // Conditional per-status updates guard against concurrent double-processing (TC-TRF-50).
    for (const [group, status] of [[received, 'RECEIVED'], [rejected, 'NOT_RECEIVED']] as const) {
      for (let i = 0; i < group.length; i += 5000) {
        const chunk = group.slice(i, i + 5000);
        if (status === 'RECEIVED') {
          const n = await t.transferLine.updateMany({ where: { id: { in: chunk.map((l) => l.id) }, status: 'IN_TRANSIT' }, data: { status, receiptId: receipt.id, receivedByName: data.receivedByName, resolvedAt: now, resolvedById: actor.id } });
          if (n.count !== chunk.length) throw conflict('Another user processed some of these lines at the same moment. Refresh and try again.');
        } else {
          for (const l of chunk) {
            const d = byId.get(l.id)!;
            const n = await t.transferLine.updateMany({ where: { id: l.id, status: 'IN_TRANSIT' }, data: { status, receiptId: receipt.id, receivedByName: data.receivedByName, rejectReason: d.reason, remark: d.remark, resolvedAt: now, resolvedById: actor.id } });
            if (n.count !== 1) throw conflict('Another user processed some of these lines at the same moment. Refresh and try again.');
          }
        }
      }
    }
    // Remarks on received lines
    for (const l of received) { const d = byId.get(l.id)!; if (d.remark) await t.transferLine.update({ where: { id: l.id }, data: { remark: d.remark } }); }

    // Received: location (and a location-holder at the sender) moves to the destination.
    const recIds = received.map((l) => l.assetId);
    for (let i = 0; i < recIds.length; i += 5000) {
      const chunk = recIds.slice(i, i + 5000);
      await t.asset.updateMany({ where: { id: { in: chunk } }, data: { locationId: transfer.toLocationId, updatedById: actor.id } });
      await t.asset.updateMany({ where: { id: { in: chunk }, holderType: 'LOCATION', holderLocation: { idPath: { startsWith: transfer.fromLocation.idPath } } }, data: { holderLocationId: transfer.toLocationId } });
    }
    const holderMoved = received.filter((l) => l.asset.holderType === 'LOCATION' && l.asset.holderLocation?.idPath.startsWith(transfer.fromLocation.idPath));
    for (const l of holderMoved) {
      await t.assetAssignment.updateMany({ where: { assetId: l.assetId, endAt: null }, data: { endAt: now, endedById: actor.id } });
      await t.assetAssignment.create({ data: { assetId: l.assetId, holderType: 'LOCATION', holderId: transfer.toLocationId, holderName: transfer.toLocation.namePath, startAt: now, assignedById: actor.id, source: 'TRANSFER' } });
    }
    const holderMovedIds = new Set(holderMoved.map((l) => l.id));
    const hName = (a: (typeof lines)[number]['asset']) => a.holderEmployee ? `${a.holderEmployee.name} (${a.holderEmployee.employeeCode})` : a.holderDepartment?.name ?? a.holderLocation?.namePath ?? null;
    const approverName = transfer.approverNames;
    const onBehalf = actor.role !== 'BRANCH_USER' ? ' (processed by IT on behalf of the branch)' : '';
    const movements: Prisma.AssetMovementCreateManyInput[] = lines.map((l) => {
      const d = byId.get(l.id)!;
      const ok = d.outcome === 'RECEIVED';
      const h = holderOf(l.asset);
      return {
        assetId: l.assetId, kind: ok ? 'TRANSFER_RECEIVED' : 'TRANSFER_NOT_RECEIVED',
        fromLocationId: transfer.fromLocationId, fromLocationName: transfer.fromLocation.namePath,
        toLocationId: ok ? transfer.toLocationId : transfer.fromLocationId, toLocationName: ok ? transfer.toLocation.namePath : transfer.fromLocation.namePath,
        fromHolderType: h?.type ?? null, fromHolderId: h?.id ?? null, fromHolderName: hName(l.asset),
        toHolderType: h?.type ?? null, toHolderId: holderMovedIds.has(l.id) ? transfer.toLocationId : h?.id ?? null, toHolderName: holderMovedIds.has(l.id) ? transfer.toLocation.namePath : hName(l.asset),
        fromStatus: l.asset.status, toStatus: l.asset.status, effectiveAt, recordedAt: now,
        actorId: actor.id, actorName: actor.name, transferId, transferLineId: l.id, approverName, receivedByName: data.receivedByName,
        reason: ok ? `Transfer ${transfer.transferNo} (requested by ${transfer.requestedByName})${onBehalf}` : d.reason, remarks: d.remark,
      };
    });
    for (let i = 0; i < movements.length; i += 5000) await t.assetMovement.createMany({ data: movements.slice(i, i + 5000) });

    // Not received: asset stays at the sender, line becomes a transfer exception (FR-TRF-08).
    if (rejected.length) {
      await t.transferException.createMany({ data: rejected.map((l) => ({ lineId: l.id, transferId, assetId: l.assetId, reason: byId.get(l.id)!.reason! })) });
      await t.asset.updateMany({ where: { id: { in: rejected.map((l) => l.assetId) } }, data: { flagTransferException: true } });
    }
    await auditMany(t, actor, lines.map((l) => {
      const d = byId.get(l.id)!;
      return { action: d.outcome === 'RECEIVED' ? 'TRANSFER_LINE_RECEIVED' : 'TRANSFER_LINE_REJECTED', entityType: 'Asset', entityId: l.assetId, entityLabel: l.assetCode, before: { locationId: transfer.fromLocationId }, after: { locationId: d.outcome === 'RECEIVED' ? transfer.toLocationId : transfer.fromLocationId }, details: { transferNo: transfer.transferNo, receivedBy: data.receivedByName, reason: d.reason, remark: d.remark, onBehalf: !!onBehalf }, locationIds: [transfer.fromLocationId, transfer.toLocationId] };
    }));
    const header = await recomputeHeader(t, transferId);
    const total = await t.transferLine.count({ where: { transferId } });
    const resolved = await t.transferLine.count({ where: { transferId, status: { in: ['RECEIVED', 'NOT_RECEIVED', 'RECALLED'] } } });
    await audit(t, actor, { action: 'TRANSFER_RECEIPT', entityType: 'Transfer', entityId: transferId, entityLabel: transfer.transferNo, details: { receiptId: receipt.id, receivedBy: data.receivedByName, received: received.length, rejected: rejected.length, progress: `${resolved} of ${total} resolved`, status: header.status, onBehalf: !!onBehalf }, locationIds: [transfer.fromLocationId, transfer.toLocationId] });

    const it = await itUserIds(t);
    const senders = [...(await branchUserIdsFor(t, transfer.fromLocationId)), transfer.requestedById];
    await notifyUsers(t, [...senders, ...it], { type: 'TRANSFER_RECEIVED', title: `${transfer.transferNo}: ${received.length} received${rejected.length ? `, ${rejected.length} not received` : ''}`, body: `${transfer.toLocation.namePath} processed ${lines.length} line(s) (received by ${data.receivedByName}). Progress: ${resolved} of ${total} resolved.`, link: `/transfers/${transferId}`, eventKey: `transfer:${transferId}:receipt:${receipt.id}` });
    if (rejected.length) {
      await notifyUsers(t, it, { type: 'TRANSFER_EXCEPTION', email: true, title: `Transfer exception on ${transfer.transferNo}`, body: `${rejected.length} asset(s) were not received at ${transfer.toLocation.namePath}: ${rejected.slice(0, 10).map((l) => `${l.assetCode} (${byId.get(l.id)!.reason})`).join(', ')}${rejected.length > 10 ? '…' : ''}. They remain at ${transfer.fromLocation.namePath}.`, link: `/transfers/exceptions`, eventKey: `transfer:${transferId}:exception:${receipt.id}` });
    }
    if (header.status === 'COMPLETED') {
      await notifyUsers(t, [...senders, ...it], { type: 'TRANSFER_COMPLETED', title: `Transfer ${transfer.transferNo} completed`, body: `All ${total} line(s) are resolved.`, link: `/transfers/${transferId}`, eventKey: `transfer:${transferId}:completed` });
    }
    return { receiptId: receipt.id, received: received.length, rejected: rejected.length, resolved, total, status: header.status };
  }, { timeoutMs: 300_000 });
}

// ───────────── Exceptions (FR-TRF-10) ─────────────

export async function listExceptions(actor: Actor, p: { status?: string; skip: number; take: number }) {
  const where: Prisma.TransferExceptionWhereInput = {
    ...(p.status === 'OPEN' || p.status === 'RESOLVED' ? { status: p.status } : {}),
    ...(actor.role === 'BRANCH_USER' ? { line: { transfer: transferScope(actor) } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.transferException.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, include: { line: { select: { assetCode: true, serialNumber: true, make: true, model: true, receivedByName: true, transfer: { select: { id: true, transferNo: true, fromLocation: { select: { namePath: true } }, toLocation: { select: { namePath: true } }, requestedByName: true } } } } } }),
    prisma.transferException.count({ where }),
  ]);
  const now = Date.now();
  return { rows: rows.map((r) => ({ ...r, daysOpen: Math.floor(((r.resolvedAt?.getTime() ?? now) - r.createdAt.getTime()) / 86_400_000), owner: 'IT' })), total };
}

export const resolveInput = z.object({
  exceptionIds: z.array(z.string()).min(1),
  resolution: z.enum(['RESENT', 'LOCATED_AT_SENDER', 'WRITTEN_OFF']),
  note: z.string().trim().max(1000).optional(),
});

export async function resolveExceptions(actor: Actor, input: unknown) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Exception resolution is an IT function.');
  const data = resolveInput.parse(input);
  return tx(async (t) => {
    const exs = await t.transferException.findMany({ where: { id: { in: data.exceptionIds } }, include: { line: { include: { transfer: true, asset: true } } } });
    if (exs.length !== data.exceptionIds.length) throw notFound('Exception');
    const closed = exs.filter((e) => e.status !== 'OPEN');
    if (closed.length) throw conflict(`${closed.length} exception(s) are already resolved.`);
    const now = new Date();
    if (data.resolution === 'LOCATED_AT_SENDER') {
      await t.transferException.updateMany({ where: { id: { in: data.exceptionIds } }, data: { status: 'RESOLVED', resolution: 'LOCATED_AT_SENDER', resolutionNote: data.note, resolvedById: actor.id, resolvedAt: now } });
      await clearExceptionFlags(t, exs.map((e) => e.assetId));
    } else if (data.resolution === 'RESENT') {
      // Group by transfer route; each group becomes a new IT-raised transfer line set.
      const groups = new Map<string, typeof exs>();
      for (const e of exs) { const k = `${e.line.transfer.fromLocationId}>${e.line.transfer.toLocationId}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
      const created: string[] = [];
      for (const g of groups.values()) {
        const tr = g[0].line.transfer;
        const r = await createTransfer(actor, { fromLocationId: tr.fromLocationId, toLocationId: tr.toLocationId, reason: `Re-send of ${[...new Set(g.map((e) => e.line.transfer.transferNo))].join(', ')}${data.note ? `: ${data.note}` : ''}`, assetIds: g.map((e) => e.assetId), submit: true, linkedReference: tr.transferNo }, { db: t, resendOfExceptionIds: g.map((e) => e.id) });
        const newId = (r as { transfer: Transfer }).transfer.id;
        created.push((r as { transfer: Transfer }).transfer.transferNo);
        await t.transferException.updateMany({ where: { id: { in: g.map((e) => e.id) } }, data: { status: 'RESOLVED', resolution: 'RESENT', resolutionNote: data.note, resolvedById: actor.id, resolvedAt: now, resendTransferId: newId } });
      }
      await clearExceptionFlags(t, exs.map((e) => e.assetId));
      await audit(t, actor, { action: 'TRANSFER_EXCEPTIONS_RESOLVED', entityType: 'TransferException', entityLabel: created.join(', '), details: { resolution: 'RESENT', count: exs.length, newTransfers: created, note: data.note } });
      await auditMany(t, actor, exs.map((e) => ({ action: 'TRANSFER_EXCEPTION_RESOLVED', entityType: 'Asset', entityId: e.assetId, entityLabel: e.line.assetCode, details: { resolution: 'RESENT', transferNo: e.line.transfer.transferNo, newTransfers: created }, locationIds: [e.line.transfer.fromLocationId] })));
      return { resolved: exs.length, newTransfers: created };
    } else {
      // Written off → retire with disposal "Lost", approval-gated where a RETIRE policy matches.
      const assets = exs.map((e) => e.line.asset);
      const policy = await findPolicy(t, 'RETIRE', await matchContextForAssets(t, assets.map((a) => a.id), actor.role));
      const reason = `Written off: not received on ${[...new Set(exs.map((e) => e.line.transfer.transferNo))].join(', ')}${data.note ? ` — ${data.note}` : ''}`;
      await forceToStock(t, actor, assets, reason);
      if (policy) {
        const req = await createApprovalRequest(t, actor, { action: 'RETIRE', policy, summary: `Write off ${assets.length} asset(s) as Lost`, entityType: 'Asset', assetIds: assets.map((a) => a.id), locationIds: [...new Set(assets.map((a) => a.locationId!).filter(Boolean))], payload: { op: 'retire', assetIds: assets.map((a) => a.id), reason, disposalType: 'LOST', exceptionIds: data.exceptionIds } });
        await audit(t, actor, { action: 'TRANSFER_EXCEPTION_WRITE_OFF_REQUESTED', entityType: 'TransferException', entityLabel: req.requestNo, details: { count: exs.length } });
        return { pendingApproval: { id: req.id, requestNo: req.requestNo, policy: policy.name } };
      }
      const { execRetire } = await import('./lifecycle');
      for (const a of await t.asset.findMany({ where: { id: { in: assets.map((x) => x.id) } } })) await execRetire(t, actor, a, { reason, disposalType: 'LOST' });
      await closeWrittenOffExceptions(t, actor, data.exceptionIds, null, data.note);
    }
    await audit(t, actor, { action: 'TRANSFER_EXCEPTIONS_RESOLVED', entityType: 'TransferException', entityLabel: `${exs.length} exception(s)`, details: { resolution: data.resolution, note: data.note, assets: exs.map((e) => e.line.assetCode) } });
    await auditMany(t, actor, exs.map((e) => ({ action: 'TRANSFER_EXCEPTION_RESOLVED', entityType: 'Asset', entityId: e.assetId, entityLabel: e.line.assetCode, details: { resolution: data.resolution, transferNo: e.line.transfer.transferNo, note: data.note }, locationIds: [e.line.transfer.fromLocationId] })));
    return { resolved: exs.length };
  }, { timeoutMs: 120_000 });
}

/** Bring written-off assets to In stock (check-in / end repair) so that retirement preconditions hold. */
async function forceToStock(t: Db, actor: Actor, assets: Asset[], reason: string) {
  const { execCheckIn, execRepairDone } = await import('./lifecycle');
  for (const a0 of assets) {
    let a = await t.asset.findUniqueOrThrow({ where: { id: a0.id } });
    if (a.status === 'RETIRED') throw conflict(`Asset ${a.assetCode} is already retired.`);
    if (a.status === 'UNDER_REPAIR') a = await execRepairDone(t, actor, a, { remarks: reason });
    if (a.status === 'ASSIGNED') await execCheckIn(t, actor, a, { remarks: reason });
  }
}

export async function closeWrittenOffExceptions(t: Db, actor: Actor, exceptionIds: string[], approvers: string | null, note?: string) {
  const exs = await t.transferException.findMany({ where: { id: { in: exceptionIds }, status: 'OPEN' } });
  await t.transferException.updateMany({ where: { id: { in: exs.map((e) => e.id) } }, data: { status: 'RESOLVED', resolution: 'WRITTEN_OFF', resolutionNote: note ?? (approvers ? `Approved by ${approvers}` : null), resolvedById: actor.id === 'system' ? null : actor.id, resolvedAt: new Date() } });
  await clearExceptionFlags(t, exs.map((e) => e.assetId));
}

async function clearExceptionFlags(t: Db, assetIds: string[]) {
  for (const id of new Set(assetIds)) {
    const open = await t.transferException.count({ where: { assetId: id, status: 'OPEN' } });
    if (!open) await t.asset.update({ where: { id }, data: { flagTransferException: false } });
  }
}

// ───────────── Queries ─────────────

export interface TransferFilters { status?: string[]; direction?: 'inbound' | 'outbound'; fromLocationId?: string; toLocationId?: string; search?: string; dateFrom?: string; dateTo?: string; interState?: boolean; requestedById?: string }

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

export async function getTransfer(actor: Actor, id: string) {
  const tr = await prisma.transfer.findFirst({ where: { AND: [{ OR: [{ id }, { transferNo: id.toUpperCase() }] }, transferScope(actor)] }, include: { fromLocation: true, toLocation: true, receipts: { orderBy: { createdAt: 'asc' } } } });
  if (!tr) throw notFound('Transfer');
  const counts = (await lineCounts([tr.id]))(tr.id);
  const approval = tr.approvalRequestId ? await prisma.approvalRequest.findUnique({ where: { id: tr.approvalRequestId }, include: { tasks: { orderBy: { stepOrder: 'asc' } } } }) : null;
  const exceptions = await prisma.transferException.findMany({ where: { transferId: tr.id } });
  const isReceiver = actor.role !== 'BRANCH_USER' || inScopePath(actor, tr.toLocation.idPath);
  const open = tr.status === 'IN_TRANSIT' || tr.status === 'PARTIALLY_RECEIVED';
  return {
    ...tr,
    counts,
    progress: `${counts.resolved} of ${counts.total} resolved`,
    approval,
    exceptions,
    permissions: {
      canApprove: !!approval && approval.status === 'PENDING' && approval.tasks.some((x) => x.stepOrder === approval.currentOrder && canActOnTask(actor, approval, x)),
      canCancel: (tr.status === 'DRAFT' || tr.status === 'PENDING_APPROVAL') && (tr.requestedById === actor.id || actor.role === 'ADMIN'),
      canSubmit: tr.status === 'DRAFT' && (tr.requestedById === actor.id || actor.role !== 'BRANCH_USER'),
      canRecall: open && actor.role !== 'BRANCH_USER',
      canReceive: open && isReceiver,
      isReceiver,
    },
  };
}

export async function listLines(actor: Actor, transferId: string, p: { status?: string; search?: string; skip: number; take: number }) {
  const tr = await prisma.transfer.findFirst({ where: { AND: [{ id: transferId }, transferScope(actor)] }, select: { id: true } });
  if (!tr) throw notFound('Transfer');
  const where: Prisma.TransferLineWhereInput = {
    transferId,
    ...(p.status ? { status: p.status as TransferLineStatus } : {}),
    ...(p.search ? { OR: [{ assetCode: { contains: p.search, mode: 'insensitive' } }, { serialNumber: { contains: p.search, mode: 'insensitive' } }, { make: { contains: p.search, mode: 'insensitive' } }, { model: { contains: p.search, mode: 'insensitive' } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.transferLine.findMany({ where, orderBy: { assetCode: 'asc' }, skip: p.skip, take: p.take, include: { exception: { select: { id: true, status: true, resolution: true } }, receipt: { select: { actorName: true, createdAt: true } } } }),
    prisma.transferLine.count({ where }),
  ]);
  return { rows, total };
}

/** FR-TRF-05: inbound transfers for the receiver. */
export async function inbox(actor: Actor, p: { skip: number; take: number; includeClosed?: boolean }) {
  const f: TransferFilters = { status: p.includeClosed ? undefined : ['IN_TRANSIT', 'PARTIALLY_RECEIVED'] };
  if (actor.role === 'BRANCH_USER') f.direction = 'inbound';
  return listTransfers(actor, f, { ...p, sort: 'approvedAt', dir: 'asc' });
}

export function transferNoteTitle(t: Pick<Transfer, 'transferNo'>) {
  return `Transfer note ${t.transferNo}`;
}
export { fmtDateOnly };
