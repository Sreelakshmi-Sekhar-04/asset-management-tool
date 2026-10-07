import type { ApprovalAction, ApprovalRequest, Prisma } from '@prisma/client';
import type { Actor } from '../actor';
import { execAssign, execCheckIn, execBulk, execTransfer, type BulkPayload } from './lifecycle';
import { dispatchApprovedTransfer } from './transfer-receipt';
import { bulkAddAssets, createAsset } from './assets';
import { holderName } from './movement';

type T = Prisma.TransactionClient;
type Handler = {
  execute: (t: T, initiator: Actor, req: ApprovalRequest, approvers: string, decider: Actor) => Promise<void>;
  onAdvanced?: (t: T, req: ApprovalRequest, nextOrder: number) => Promise<void>;
  onRejected?: (t: T, actor: Actor, req: ApprovalRequest, comment: string) => Promise<void>;
  onCancelled?: (t: T, actor: Actor, req: ApprovalRequest) => Promise<void>;
};

const p = <X>(r: ApprovalRequest) => r.payload as unknown as X;

/** Executes the gated action once the final approval step is approved (FR-APR-01). */
export const approvalHandlers: Record<ApprovalAction, Handler> = {
  ASSET_CREATE: {
    async execute(t, initiator, req, approvers) {
      const pl = p<{ assets?: unknown[]; bulk?: unknown }>(req);
      if (pl.bulk) await bulkAddAssets(initiator, pl.bulk, { db: t, skipApproval: true, approverName: approvers });
      for (const a of pl.assets ?? []) await createAsset(initiator, a, { db: t, skipApproval: true, approverName: approvers });
    },
  },
  // Assign: an employee / department holder. (Requests raised before transfers had their own
  // two-step approval may still carry op: 'transfer'; they are carried out the same way.)
  ASSIGN: {
    async execute(t, initiator, req, approvers) {
      const pl = p<{ op?: string; assetId?: string; assetIds?: string[]; holder?: { type: 'EMPLOYEE' | 'DEPARTMENT' | 'LOCATION'; id: string }; toLocationId?: string; remarks?: string }>(req);
      const assets = await t.asset.findMany({ where: { id: { in: pl.assetIds ?? [pl.assetId!] } }, orderBy: { assetCode: 'asc' } });
      for (const asset of assets) {
        if (pl.op === 'transfer') await execTransfer(t, initiator, asset, pl.toLocationId!, pl.remarks ?? null, { approvalId: req.id, approverName: approvers });
        else await execAssign(t, initiator, asset, pl.holder!, pl.remarks ?? null, { approvalId: req.id, approverName: approvers });
      }
      void holderName;
    },
  },
  CHECK_IN: {
    async execute(t, initiator, req, approvers) {
      const pl = p<{ assetId?: string; assetIds?: string[]; condition?: string; remarks?: string }>(req);
      const assets = await t.asset.findMany({ where: { id: { in: pl.assetIds ?? [pl.assetId!] } }, orderBy: { assetCode: 'asc' } });
      for (const asset of assets) await execCheckIn(t, initiator, asset, pl, { approvalId: req.id, approverName: approvers });
    },
  },
  STATUS_CHANGE: {
    async execute(t, initiator, req, approvers) {
      await execBulk(t, initiator, p<BulkPayload>(req), undefined, { approvalId: req.id, approverName: approvers });
    },
  },
  RETIRE: {
    async execute(t, initiator, req, approvers) {
      await execBulk(t, initiator, { ...p<BulkPayload>(req), op: 'retire' }, undefined, { approvalId: req.id, approverName: approvers });
    },
  },
  // A transfer (assets assigned to a location from the asset register). Step 1 is an
  // Administrator, step 2 the destination's location manager; only after both does anything move.
  TRANSFER: {
    // Both approvals authorise the move; the assets stay put until the destination confirms receipt.
    async execute(t, initiator, req, approvers, decider) {
      await dispatchApprovedTransfer(t, initiator, req, approvers, decider);
    },
    async onAdvanced(t, req) {
      await t.asset.updateMany({ where: { transferRequestId: req.id }, data: { transferStatus: 'PENDING_LOCATION_MANAGER' } });
    },
    // Rejected at either step: the assets never moved, so only their transfer status changes.
    async onRejected(t, _actor, req) {
      await t.asset.updateMany({ where: { transferRequestId: req.id }, data: { transferStatus: 'REJECTED' } });
    },
    async onCancelled(t, _actor, req) {
      await t.asset.updateMany({ where: { transferRequestId: req.id }, data: { transferStatus: 'NONE', transferRequestId: null } });
    },
  },
};
