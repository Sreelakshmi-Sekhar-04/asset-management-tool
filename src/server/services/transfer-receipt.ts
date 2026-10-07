import { z } from 'zod';
import type { ApprovalRequest, Prisma } from '@prisma/client';
import { prisma, tx, type Db } from '@/lib/db';
import { RECEIPT_CONDITION_LABEL } from '@/lib/asset-status';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { dateOnly, todayIST } from '@/lib/format';
import type { Actor } from '../actor';
import { audit, auditMany } from '../audit';
import { adminUserIds, notifyUsers } from '../notify';
import { transferMail } from '../transfer-email';
import { canSeeRequest } from './approvals';
import { execTransfer, locationManager, preTransfer } from './lifecycle';
import { effectiveState } from './locations';
import { holderOf, recordMovement } from './movement';

/**
 * After approval, a transfer is a shipment waiting for the destination to confirm receipt.
 *
 *   request → admin manager approves → destination manager approves → DISPATCHED (in transit)
 *           → destination confirms what arrived and its condition → COMPLETED
 *
 * Both approvals only authorise the move: the assets stay at the source, shown as
 * "Transfer approved · awaiting receipt", until the destination records a receipt. Each asset
 * then moves (Good, Damaged, Partially damaged) or is reported Not received, which opens a
 * transfer exception and leaves it at the source. The shipment is kept in the transfers /
 * transfer_lines / transfer_receipts / transfer_exceptions tables, so the history stays complete.
 */

type Payload = { assetIds: string[]; toLocationId: string; remarks?: string | null };

/** Called when the last approval is given: record the shipment(s); nothing moves yet. */
export async function dispatchApprovedTransfer(t: Prisma.TransactionClient, initiator: Actor, req: ApprovalRequest, approvers: string, decider: Actor) {
  const pl = req.payload as Payload;
  const to = await t.location.findUniqueOrThrow({ where: { id: pl.toLocationId }, select: { id: true, namePath: true } });
  const assets = await t.asset.findMany({ where: { id: { in: pl.assetIds } }, orderBy: { assetCode: 'asc' } });
  // Re-check what can have changed while the request waited (retired, under repair, already there …).
  for (const a of assets) await preTransfer(t, initiator, a, to, { approvalId: req.id });
  const bySource = new Map<string, typeof assets>();
  for (const a of assets) bySource.set(a.locationId!, [...(bySource.get(a.locationId!) ?? []), a]);
  const now = new Date();
  const toState = await effectiveState(t, to.id);
  const transferNos: string[] = [];
  for (const [fromId, group] of bySource) {
    const from = await t.location.findUniqueOrThrow({ where: { id: fromId }, select: { namePath: true } });
    const tr = await t.transfer.create({
      data: {
        fromLocationId: fromId, toLocationId: to.id, reason: pl.remarks || req.summary, remarks: pl.remarks ?? null, status: 'IN_TRANSIT',
        interState: (await effectiveState(t, fromId)) !== toState,
        requestedById: req.initiatorId, requestedByName: req.initiatorName, requestedByRole: req.initiatorRole, requestedAt: req.createdAt, submittedAt: req.createdAt,
        effectiveDate: dateOnly(todayIST()), approvalRequestId: req.id, approvedAt: now, approverNames: approvers, lineCount: group.length,
      },
    });
    transferNos.push(tr.transferNo);
    await t.transferLine.createMany({
      data: group.map((a) => ({ transferId: tr.id, assetId: a.id, status: 'IN_TRANSIT' as const, assetCode: a.assetCode, serialNumber: a.serialNumber, make: a.make, model: a.model, assetStatusAtDispatch: a.status })),
    });
    await audit(t, decider, {
      action: 'TRANSFER_DISPATCHED', entityType: 'Transfer', entityId: tr.id, entityLabel: tr.transferNo,
      details: { requestNo: req.requestNo, approvers, from: from.namePath, to: to.namePath, assets: group.map((a) => a.assetCode) }, locationIds: [fromId, to.id],
    });
  }
  await t.asset.updateMany({ where: { id: { in: assets.map((a) => a.id) } }, data: { transferStatus: 'APPROVED' } });
  // The destination's manager confirms receipt; tell them it is on its way.
  const manager = await locationManager(t, to.id).catch(() => null);
  if (manager) {
    await notifyUsers(t, [manager.userId], {
      type: 'TRANSFER_IN_TRANSIT', title: `Confirm receipt when it arrives: ${req.summary}`,
      body: `${req.requestNo} has both approvals (${approvers}). Confirm what actually arrives at ${to.namePath.split(' / ').pop()} and its condition.`,
      link: `/approvals/${req.id}`, eventKey: `transfer:${req.id}:dispatched`,
      mail: await transferMail(t, req, 'RECEIVE', transferNos.join(', ')),
    });
  }
}

// ───────────── Who may confirm receipt ─────────────

async function receiverIds(db: Db, toLocationId: string) {
  const m = await locationManager(db, toLocationId).catch(() => null);
  return m ? [m.userId] : [];
}

/** Administrators, and the destination's location manager. */
async function canReceive(db: Db, actor: Actor, toLocationId: string) {
  if (actor.role === 'ADMIN') return true;
  return (await receiverIds(db, toLocationId)).includes(actor.id);
}

// ───────────── Reading: the shipments of a request, and what is waiting for me ─────────────

const shipmentInclude = {
  fromLocation: { select: { namePath: true } },
  toLocation: { select: { id: true, namePath: true } },
  lines: { orderBy: { assetCode: 'asc' }, include: { exception: true } },
  receipts: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.TransferInclude;

type Shipment = Prisma.TransferGetPayload<{ include: typeof shipmentInclude }>;

async function shape(actor: Actor, s: Shipment) {
  const receiver = await canReceive(prisma, actor, s.toLocationId);
  const open = s.lines.filter((l) => l.status === 'IN_TRANSIT' || (l.status === 'NOT_RECEIVED' && l.exception?.status === 'OPEN'));
  return {
    id: s.id, transferNo: s.transferNo, status: s.status, approvalRequestId: s.approvalRequestId,
    from: s.fromLocation.namePath, to: s.toLocation.namePath, effectiveDate: s.effectiveDate,
    requestedByName: s.requestedByName, requestedAt: s.requestedAt, approvedAt: s.approvedAt, approverNames: s.approverNames, completedAt: s.completedAt,
    canReceive: receiver && open.length > 0,
    canClose: actor.role === 'ADMIN' && s.lines.some((l) => l.exception?.status === 'OPEN'),
    lines: s.lines.map((l) => ({
      id: l.id, assetId: l.assetId, assetCode: l.assetCode, name: [l.make, l.model].filter(Boolean).join(' '), serialNumber: l.serialNumber,
      status: l.status, condition: l.receivedCondition, remark: l.remark, receivedAt: l.receivedAt, receivedByName: l.receivedByName,
      exception: l.exception ? { status: l.exception.status, reason: l.exception.reason, resolution: l.exception.resolution, resolutionNote: l.exception.resolutionNote } : null,
      open: open.includes(l),
    })),
    receipts: s.receipts.map((r) => ({ id: r.id, receivedByName: r.receivedByName, receivedAt: r.receivedAt, recordedBy: r.actorName, recordedAt: r.createdAt, remarks: r.remarks })),
  };
}

export async function shipmentsForRequest(actor: Actor, requestId: string) {
  const req = await prisma.approvalRequest.findUnique({ where: { id: requestId }, include: { tasks: { select: { approverUserId: true } } } });
  if (!req || !(await canSeeRequest(actor, req))) throw notFound('Approval request');
  const rows = await prisma.transfer.findMany({ where: { approvalRequestId: requestId }, include: shipmentInclude, orderBy: { transferNo: 'asc' } });
  return Promise.all(rows.map((s) => shape(actor, s)));
}

/** Approved transfers waiting for the actor to confirm receipt (or with a not-received exception open). */
export async function listToReceive(actor: Actor) {
  const rows = await prisma.transfer.findMany({
    where: { approvalRequestId: { not: null }, status: { in: ['IN_TRANSIT', 'PARTIALLY_RECEIVED'] } },
    include: shipmentInclude, orderBy: { approvedAt: 'asc' },
  });
  const out = [];
  for (const s of rows) {
    const v = await shape(actor, s);
    if (v.canReceive || v.canClose) out.push(v);
  }
  return out;
}

export async function toReceiveCount(actor: Actor) {
  return (await listToReceive(actor)).filter((s) => s.canReceive).length;
}

// ───────────── Confirming receipt ─────────────

export const receiptInput = z.object({
  receivedAt: z.string().min(1, 'Enter when the assets arrived').refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date and time'),
  receivedByName: z.string().trim().min(1, 'Enter who received the assets').max(120),
  remarks: z.string().trim().max(1000).optional().nullable(),
  lines: z.array(z.object({
    lineId: z.string().min(1),
    condition: z.enum(['GOOD', 'DAMAGED', 'PARTIALLY_DAMAGED', 'NOT_RECEIVED']),
    remarks: z.string().trim().max(1000).optional().nullable(),
  })).min(1, 'Record the condition of each asset'),
});

export async function receiveTransfer(actor: Actor, transferId: string, input: unknown) {
  const data = receiptInput.parse(input);
  const problems = data.lines.filter((l) => l.condition !== 'GOOD' && !l.remarks?.trim())
    .map((l) => ({ field: `lines.${l.lineId}.remarks`, message: `Describe the problem (${RECEIPT_CONDITION_LABEL[l.condition].toLowerCase()})` }));
  if (problems.length) throw badRequest('Add remarks for every asset that is damaged or not received.', problems);
  const receivedAt = new Date(data.receivedAt);
  if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('The received date and time cannot be in the future.', [{ field: 'receivedAt', message: 'In the future' }]);

  return tx(async (t) => {
    await t.$queryRaw`SELECT id FROM transfers WHERE id = ${transferId} FOR UPDATE`;
    const tr = await t.transfer.findUnique({ where: { id: transferId }, include: { lines: { include: { exception: true } }, toLocation: { select: { namePath: true } }, fromLocation: { select: { namePath: true } } } });
    if (!tr || !tr.approvalRequestId) throw notFound('Transfer');
    if (!(await canReceive(t, actor, tr.toLocationId))) throw forbidden(`Only the location manager of ${tr.toLocation.namePath.split(' / ').pop()} or an Administrator can confirm receipt.`);
    if (!['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(tr.status)) throw conflict(`Transfer ${tr.transferNo} is ${tr.status.toLowerCase().replace(/_/g, ' ')}; there is nothing left to receive.`);
    if (tr.approvedAt && receivedAt < tr.approvedAt) throw badRequest('The assets cannot have been received before the transfer was approved.', [{ field: 'receivedAt', message: 'Before the approval' }]);

    const byId = new Map(tr.lines.map((l) => [l.id, l]));
    const inTransit = tr.lines.filter((l) => l.status === 'IN_TRANSIT');
    const seen = new Set<string>();
    for (const l of data.lines) {
      const line = byId.get(l.lineId);
      if (!line) throw badRequest('An asset in the receipt is not part of this transfer.');
      if (seen.has(l.lineId)) throw badRequest(`${line.assetCode} is listed twice.`);
      seen.add(l.lineId);
      const late = line.status === 'NOT_RECEIVED' && line.exception?.status === 'OPEN';
      if (line.status !== 'IN_TRANSIT' && !late) throw conflict(`${line.assetCode} has already been ${line.status === 'RECEIVED' ? 'received' : 'closed'}.`);
      if (late && l.condition === 'NOT_RECEIVED') throw badRequest(`${line.assetCode} is already recorded as not received.`);
    }
    const missing = inTransit.filter((l) => !seen.has(l.id));
    if (missing.length) throw badRequest(`Record a condition for every asset on the transfer: ${missing.map((l) => l.assetCode).join(', ')}.`);

    const receipt = await t.transferReceipt.create({ data: { transferId: tr.id, actorId: actor.id, actorName: actor.name, receivedByName: data.receivedByName, receivedAt, remarks: data.remarks || null } });
    const approverName = tr.approverNames ?? undefined;
    let received = 0, notReceived = 0;
    const audits: Parameters<typeof auditMany>[2] = [];
    for (const l of data.lines) {
      const line = byId.get(l.lineId)!;
      const asset = await t.asset.findUniqueOrThrow({ where: { id: line.assetId } });
      const remark = l.remarks?.trim() || null;
      const label = RECEIPT_CONDITION_LABEL[l.condition];
      if (l.condition === 'NOT_RECEIVED') {
        notReceived++;
        await t.transferLine.update({ where: { id: line.id }, data: { status: 'NOT_RECEIVED', receiptId: receipt.id, receivedByName: data.receivedByName, receivedCondition: l.condition, receivedAt, remark } });
        await t.transferException.create({ data: { lineId: line.id, transferId: tr.id, assetId: asset.id, reason: remark! } });
        await t.asset.update({ where: { id: asset.id }, data: { flagTransferException: true, transferStatus: 'NOT_RECEIVED', updatedById: actor.id } });
        await recordMovement(t, actor, 'TRANSFER_NOT_RECEIVED', asset, { id: asset.id, status: asset.status, locationId: asset.locationId, holder: holderOf(asset) }, {
          transferId: tr.id, transferLineId: line.id, receivedByName: data.receivedByName, remarks: remark, effectiveAt: receivedAt, condition: label, approverName,
        });
        audits.push({ action: 'TRANSFER_EXCEPTION_RAISED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, details: { transferNo: tr.transferNo, reason: remark, condition: label, recordedBy: actor.name, to: tr.toLocation.namePath }, locationIds: [tr.fromLocationId, tr.toLocationId] });
        continue;
      }
      received++;
      await execTransfer(t, actor, asset, tr.toLocationId, remark ?? tr.remarks, {
        approvalId: tr.approvalRequestId, approverName,
        receipt: { transferId: tr.id, transferNo: tr.transferNo, lineId: line.id, receivedByName: data.receivedByName, receivedAt, condition: l.condition },
      });
      await t.transferLine.update({ where: { id: line.id }, data: { status: 'RECEIVED', receiptId: receipt.id, receivedByName: data.receivedByName, receivedCondition: l.condition, receivedAt, remark, resolvedAt: new Date(), resolvedById: actor.id } });
      if (line.exception?.status === 'OPEN') {
        await t.transferException.update({ where: { id: line.exception.id }, data: { status: 'RESOLVED', resolution: 'RESENT', resolutionNote: `Arrived late; received ${label.toLowerCase()} by ${data.receivedByName}`, resolvedById: actor.id, resolvedAt: new Date() } });
        audits.push({ action: 'TRANSFER_EXCEPTION_RESOLVED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, details: { transferNo: tr.transferNo, resolution: 'Arrived late and received' }, locationIds: [tr.toLocationId] });
      }
      const stillOpen = await t.transferException.count({ where: { assetId: asset.id, status: 'OPEN' } });
      if (!stillOpen) await t.asset.update({ where: { id: asset.id }, data: { flagTransferException: false } });
    }
    await auditMany(t, actor, audits);

    const status = await settleStatus(t, tr.id);
    await audit(t, actor, {
      action: 'TRANSFER_RECEIPT_RECORDED', entityType: 'Transfer', entityId: tr.id, entityLabel: tr.transferNo,
      details: {
        receivedBy: data.receivedByName, receivedAt: receivedAt.toISOString(), remarks: data.remarks || null, received, notReceived,
        conditions: data.lines.map((l) => ({ asset: byId.get(l.lineId)!.assetCode, condition: RECEIPT_CONDITION_LABEL[l.condition], remarks: l.remarks || null })),
      },
      locationIds: [tr.fromLocationId, tr.toLocationId],
    });
    if (status === 'COMPLETED') await audit(t, actor, { action: 'TRANSFER_COMPLETED', entityType: 'Transfer', entityId: tr.id, entityLabel: tr.transferNo, details: { to: tr.toLocation.namePath }, locationIds: [tr.fromLocationId, tr.toLocationId] });

    const req = await t.approvalRequest.findUniqueOrThrow({ where: { id: tr.approvalRequestId } });
    const dest = tr.toLocation.namePath.split(' / ').pop();
    await notifyUsers(t, [req.initiatorId, ...(notReceived ? await adminUserIds(t) : [])], {
      type: notReceived ? 'TRANSFER_EXCEPTION' : 'TRANSFER_COMPLETED',
      title: notReceived ? `Not received at ${dest}: ${tr.transferNo}` : `Received at ${dest}: ${tr.transferNo}`,
      body: notReceived
        ? `${data.receivedByName} recorded ${notReceived} asset(s) as not received at ${dest}; they stay at ${tr.fromLocation.namePath.split(' / ').pop()} until the exception is resolved.${received ? ` ${received} arrived.` : ''}`
        : `${data.receivedByName} confirmed receipt of ${received} asset(s) at ${dest}. Transfer ${tr.transferNo} is complete.`,
      link: `/approvals/${tr.approvalRequestId}`, eventKey: `transfer:${tr.id}:receipt:${receipt.id}`,
    });
    return { transferNo: tr.transferNo, status, received, notReceived };
  }, { timeoutMs: 120_000 });
}

/** COMPLETED once every asset has arrived; while one is reported not received, PARTIALLY_RECEIVED (an exception). */
async function settleStatus(t: Prisma.TransactionClient, transferId: string) {
  const lines = await t.transferLine.findMany({ where: { transferId }, include: { exception: true } });
  const openEx = lines.some((l) => l.exception?.status === 'OPEN');
  const inTransit = lines.some((l) => l.status === 'IN_TRANSIT');
  const anyReceived = lines.some((l) => l.status === 'RECEIVED');
  const status = inTransit ? 'IN_TRANSIT' : openEx ? 'PARTIALLY_RECEIVED' : anyReceived ? 'COMPLETED' : 'CANCELLED';
  await t.transfer.update({ where: { id: transferId }, data: { status, ...(status === 'COMPLETED' ? { completedAt: new Date() } : status === 'CANCELLED' ? { cancelledAt: new Date() } : {}) } });
  return status;
}

// ───────────── Closing a not-received exception: the asset never left ─────────────

export const closeExceptionInput = z.object({ note: z.string().trim().min(1, 'Say what was found').max(1000) });

/** Administrator: the asset was found at the source (never sent). It stays there and the transfer closes for it. */
export async function closeNotReceived(actor: Actor, lineId: string, input: unknown) {
  if (actor.role !== 'ADMIN') throw forbidden('Only an Administrator can close a transfer exception.');
  const { note } = closeExceptionInput.parse(input);
  return tx(async (t) => {
    const line = await t.transferLine.findUnique({ where: { id: lineId }, include: { exception: true, transfer: { select: { id: true, transferNo: true, fromLocationId: true, toLocationId: true } } } });
    if (!line?.exception || line.exception.status !== 'OPEN') throw conflict('There is no open exception for this asset on this transfer.');
    await t.transferException.update({ where: { id: line.exception.id }, data: { status: 'RESOLVED', resolution: 'LOCATED_AT_SENDER', resolutionNote: note, resolvedById: actor.id, resolvedAt: new Date() } });
    await t.transferLine.update({ where: { id: line.id }, data: { resolvedAt: new Date(), resolvedById: actor.id } });
    const stillOpen = await t.transferException.count({ where: { assetId: line.assetId, status: 'OPEN' } });
    await t.asset.update({ where: { id: line.assetId }, data: { transferStatus: 'NONE', ...(stillOpen ? {} : { flagTransferException: false }), updatedById: actor.id } });
    await audit(t, actor, { action: 'TRANSFER_EXCEPTION_RESOLVED', entityType: 'Asset', entityId: line.assetId, entityLabel: line.assetCode, details: { transferNo: line.transfer.transferNo, resolution: 'Stayed at the source location', reason: note }, locationIds: [line.transfer.fromLocationId, line.transfer.toLocationId] });
    const status = await settleStatus(t, line.transfer.id);
    await audit(t, actor, { action: status === 'COMPLETED' ? 'TRANSFER_COMPLETED' : status === 'CANCELLED' ? 'TRANSFER_CANCELLED' : 'TRANSFER_EXCEPTION_RESOLVED', entityType: 'Transfer', entityId: line.transfer.id, entityLabel: line.transfer.transferNo, details: { asset: line.assetCode, resolution: 'Stayed at the source location', note }, locationIds: [line.transfer.fromLocationId, line.transfer.toLocationId] });
    return { status };
  });
}
