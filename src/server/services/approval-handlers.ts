import type { ApprovalAction, ApprovalRequest, Prisma } from '@prisma/client';
import type { Actor } from '../actor';
import { execAssign, execCheckIn, execBulk, type BulkPayload } from './lifecycle';
import { bulkAddAssets, createAsset } from './assets';
import { onTransferApproved, onTransferRejected, onTransferCancelled } from './transfers';
import { holderName } from './movement';

type T = Prisma.TransactionClient;
type Handler = {
  execute: (t: T, initiator: Actor, req: ApprovalRequest, approvers: string, decider: Actor) => Promise<void>;
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
  ASSIGN: {
    async execute(t, initiator, req, approvers) {
      const pl = p<{ assetId?: string; assetIds?: string[]; holder: { type: 'EMPLOYEE' | 'DEPARTMENT' | 'LOCATION'; id: string }; remarks?: string }>(req);
      const assets = await t.asset.findMany({ where: { id: { in: pl.assetIds ?? [pl.assetId!] } }, orderBy: { assetCode: 'asc' } });
      for (const asset of assets) await execAssign(t, initiator, asset, pl.holder, pl.remarks ?? null, { approvalId: req.id, approverName: approvers });
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
      const pl = p<BulkPayload & { exceptionIds?: string[] }>(req);
      await execBulk(t, initiator, { ...pl, op: 'retire' }, undefined, { approvalId: req.id, approverName: approvers });
      if (pl.exceptionIds?.length) {
        const { closeWrittenOffExceptions } = await import('./transfers');
        await closeWrittenOffExceptions(t, initiator, pl.exceptionIds, approvers);
      }
    },
    async onRejected(t, actor, req) {
      const pl = p<{ exceptionIds?: string[] }>(req);
      if (pl.exceptionIds?.length) void actor; // exceptions remain open for another resolution
    },
  },
  TRANSFER: {
    execute: (t, initiator, req, approvers, decider) => onTransferApproved(t, decider, req, approvers),
    onRejected: (t, actor, req, comment) => onTransferRejected(t, actor, req, comment),
    onCancelled: (t, actor, req) => onTransferCancelled(t, actor, req),
  },
};
