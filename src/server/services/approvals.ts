import type { ApprovalAction, ApprovalPolicy, ApprovalStep, ApprovalRequest, Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma, tx, type Db } from '@/lib/db';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { HISTORIC_ACTION_LABEL } from '@/lib/labels';
import type { Actor } from '../actor';
import { resolveOrg } from '../org';
import { audit } from '../audit';
import { notifyUsers } from '../notify';

// ───────────── Policy configuration (FR-APR-01..03, FR-CFG-07) ─────────────

export const policyInput = z.object({
  name: z.string().trim().min(1).max(120),
  action: z.enum(['ASSET_CREATE', 'ASSIGN', 'CHECK_IN', 'TRANSFER', 'RETIRE', 'STATUS_CHANGE']),
  priority: z.number().int().min(1).max(10000).default(100),
  active: z.boolean().default(true),
  categoryIds: z.array(z.string()).default([]),
  minCost: z.number().nonnegative().nullable().optional(),
  minQuantity: z.number().int().positive().nullable().optional(),
  interState: z.boolean().nullable().optional(),
  initiatorRoles: z.array(z.enum(['ADMIN', 'IT_OPERATOR', 'BRANCH_USER'])).default([]),
  steps: z.array(z.object({
    stepOrder: z.number().int().min(1),
    approverType: z.enum(['USER', 'ROLE', 'HOLDER_MANAGER']),
    approverUserId: z.string().nullable().optional(),
    approverRole: z.enum(['ADMIN', 'IT_OPERATOR', 'BRANCH_USER']).nullable().optional(),
  }).refine((s) => s.approverType !== 'USER' || !!s.approverUserId, 'Choose the named approver')
    .refine((s) => s.approverType !== 'ROLE' || !!s.approverRole, 'Choose the approver role')).min(1, 'A policy needs at least one step'),
});

export async function listPolicies() {
  return prisma.approvalPolicy.findMany({ include: { steps: { orderBy: { stepOrder: 'asc' } } }, orderBy: [{ action: 'asc' }, { priority: 'asc' }] });
}

export async function savePolicy(actor: Actor, id: string | null, input: unknown) {
  const data = policyInput.parse(input);
  return tx(async (t) => {
    const before = id ? await t.approvalPolicy.findUnique({ where: { id }, include: { steps: true } }) : null;
    if (id && !before) throw notFound('Approval policy');
    const fields = {
      name: data.name, action: data.action, priority: data.priority, active: data.active, categoryIds: data.categoryIds,
      minCost: data.minCost ?? null, minQuantity: data.minQuantity ?? null, interState: data.interState ?? null, initiatorRoles: data.initiatorRoles as Role[],
    };
    const p = id
      ? await t.approvalPolicy.update({ where: { id }, data: fields })
      : await t.approvalPolicy.create({ data: fields });
    await t.approvalStep.deleteMany({ where: { policyId: p.id } });
    await t.approvalStep.createMany({ data: data.steps.map((s) => ({ policyId: p.id, stepOrder: s.stepOrder, approverType: s.approverType, approverUserId: s.approverUserId ?? null, approverRole: s.approverRole ?? null })) });
    await audit(t, actor, { action: id ? 'APPROVAL_POLICY_UPDATED' : 'APPROVAL_POLICY_CREATED', entityType: 'ApprovalPolicy', entityId: p.id, entityLabel: p.name, before, after: data });
    return t.approvalPolicy.findUnique({ where: { id: p.id }, include: { steps: true } });
  });
}

export async function deletePolicy(actor: Actor, id: string) {
  return tx(async (t) => {
    const p = await t.approvalPolicy.findUnique({ where: { id }, include: { steps: true } });
    if (!p) throw notFound('Approval policy');
    // Policies are configuration, not history; requests keep a snapshot of the policy name.
    await t.approvalPolicy.delete({ where: { id } });
    await audit(t, actor, { action: 'APPROVAL_POLICY_DELETED', entityType: 'ApprovalPolicy', entityId: id, entityLabel: p.name, before: p });
    return { ok: true };
  });
}

// ───────────── Matching (FR-APR-02) ─────────────

export interface MatchContext {
  categoryIds: string[];
  /** Highest single-asset purchase cost among the affected assets. */
  maxCost: number | null;
  quantity: number;
  interState: boolean | null;
  initiatorRole: Role;
}

export function policyMatches(p: ApprovalPolicy, c: MatchContext): boolean {
  if (!p.active) return false;
  if (p.categoryIds.length && !c.categoryIds.some((id) => p.categoryIds.includes(id))) return false;
  if (p.minCost !== null && (c.maxCost === null || c.maxCost < Number(p.minCost))) return false;
  if (p.minQuantity !== null && c.quantity < p.minQuantity) return false;
  if (p.interState !== null && c.interState !== p.interState) return false;
  if (p.initiatorRoles.length && !p.initiatorRoles.includes(c.initiatorRole)) return false;
  return true;
}

/** First matching active policy in priority order; null means "execute immediately". */
export async function findPolicy(db: Db, action: ApprovalAction, c: MatchContext) {
  const policies = await db.approvalPolicy.findMany({ where: { action, active: true }, include: { steps: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
  return policies.find((p) => policyMatches(p, c)) ?? null;
}

export async function matchContextForAssets(db: Db, assetIds: string[], initiatorRole: Role, interState: boolean | null = null): Promise<MatchContext> {
  const agg = await db.asset.groupBy({ by: ['categoryId'], where: { id: { in: assetIds } }, _max: { purchaseCost: true } });
  const maxes = agg.map((a) => (a._max.purchaseCost === null ? null : Number(a._max.purchaseCost))).filter((x): x is number => x !== null);
  return { categoryIds: agg.map((a) => a.categoryId), maxCost: maxes.length ? Math.max(...maxes) : null, quantity: assetIds.length, interState, initiatorRole };
}

// ───────────── Requests ─────────────

export interface NewRequest {
  action: ApprovalAction;
  policy: (ApprovalPolicy & { steps: ApprovalStep[] }) | null;
  /** Used when no policy matched but a built-in rule requires approval (FR-APR-07). */
  defaultSteps?: { stepOrder: number; approverType: 'ROLE' | 'USER'; approverRole?: Role; approverUserId?: string }[];
  defaultPolicyName?: string;
  summary: string;
  entityType?: string;
  entityId?: string;
  assetIds: string[];
  locationIds: string[];
  payload: Prisma.InputJsonValue;
  link?: string;
}

async function resolveHolderManagerUserId(db: Db, assetIds: string[]): Promise<string | null> {
  const a = await db.asset.findFirst({ where: { id: { in: assetIds }, holderEmployeeId: { not: null } }, select: { holderEmployee: { select: { manager: { select: { user: { select: { id: true, active: true } } } } } } } });
  const u = a?.holderEmployee?.manager?.user;
  return u?.active ? u.id : null;
}

export async function createApprovalRequest(db: Db, actor: Actor, r: NewRequest): Promise<ApprovalRequest> {
  const steps = r.policy?.steps.length ? r.policy.steps : (r.defaultSteps ?? []).map((s) => ({ ...s, approverUserId: s.approverUserId ?? null, approverRole: s.approverRole ?? null }));
  if (!steps.length) throw badRequest('The approval policy has no steps configured.');
  const minOrder = Math.min(...steps.map((s) => s.stepOrder));
  const req = await db.approvalRequest.create({
    data: {
      action: r.action, policyId: r.policy?.id ?? null, policyName: r.policy?.name ?? r.defaultPolicyName ?? 'Default rule',
      summary: r.summary, entityType: r.entityType, entityId: r.entityId, assetIds: r.assetIds, locationIds: r.locationIds, payload: r.payload,
      initiatorId: actor.id, initiatorName: actor.name, initiatorRole: actor.role, currentOrder: minOrder,
    },
  });
  for (const s of steps) {
    let approverType = s.approverType;
    let approverUserId = s.approverUserId ?? null;
    let approverRole = s.approverRole ?? null;
    if (approverType === 'HOLDER_MANAGER') {
      const uid = await resolveHolderManagerUserId(db, r.assetIds);
      if (uid) { approverType = 'USER'; approverUserId = uid; }
      else { approverType = 'ROLE'; approverRole = 'ADMIN'; } // no manager with a login → Administrators
    }
    await db.approvalTask.create({
      data: { requestId: req.id, stepOrder: s.stepOrder, approverType, approverUserId, approverRole, status: s.stepOrder === minOrder ? 'PENDING' : 'WAITING' },
    });
  }
  await audit(db, actor, { action: 'APPROVAL_REQUESTED', entityType: 'ApprovalRequest', entityId: req.id, entityLabel: req.requestNo, details: { action: r.action, policy: req.policyName, summary: r.summary, assets: r.assetIds.length }, locationIds: r.locationIds });
  await notifyApprovers(db, req.id, r.link);
  return req;
}

async function approverUserIds(db: Db, task: { approverType: string; approverUserId: string | null; approverRole: Role | null }, excludeUserId?: string) {
  if (task.approverType === 'USER') return task.approverUserId && task.approverUserId !== excludeUserId ? [task.approverUserId] : [];
  const roles: Role[] = task.approverRole === 'IT_OPERATOR' ? ['IT_OPERATOR', 'ADMIN'] : task.approverRole ? [task.approverRole] : [];
  const users = await db.user.findMany({ where: { active: true, role: { in: roles } }, select: { id: true } });
  return users.map((u) => u.id).filter((id) => id !== excludeUserId);
}

async function notifyApprovers(db: Db, requestId: string, link?: string) {
  const req = await db.approvalRequest.findUniqueOrThrow({ where: { id: requestId }, include: { tasks: { where: { status: 'PENDING' } } } });
  const ids = new Set<string>();
  for (const t of req.tasks) for (const id of await approverUserIds(db, t, req.initiatorRole === 'ADMIN' ? undefined : req.initiatorId)) ids.add(id);
  await notifyUsers(db, [...ids], {
    type: req.action === 'TRANSFER' ? 'TRANSFER_APPROVAL_REQUESTED' : 'APPROVAL_REQUESTED',
    title: `Approval needed: ${req.summary}`,
    body: `${req.initiatorName} requested ${(HISTORIC_ACTION_LABEL[req.action] ?? req.action).toLowerCase()} (${req.requestNo}). Policy: ${req.policyName}.`,
    link: link ?? `/approvals?request=${req.id}`,
    eventKey: `approval:${req.id}:order:${req.currentOrder}`,
  });
}

export function canActOnTask(actor: Actor, req: Pick<ApprovalRequest, 'initiatorId' | 'action'>, task: { status: string; approverType: string; approverUserId: string | null; approverRole: Role | null }) {
  if (task.status !== 'PENDING') return false;
  // Branch users approve a transfer only as the destination's named location manager.
  if (actor.role === 'BRANCH_USER' && req.action === 'TRANSFER' && !(task.approverType === 'USER' && task.approverUserId === actor.id)) return false;
  if (req.initiatorId === actor.id && actor.role !== 'ADMIN') return false; // no self-approval except Administrator
  if (task.approverType === 'USER') return task.approverUserId === actor.id;
  if (task.approverType === 'ROLE') return task.approverRole === actor.role || (task.approverRole === 'IT_OPERATOR' && actor.role === 'ADMIN');
  return false;
}

// ───────────── Decisions (FR-APR-04) ─────────────

type Handler = {
  execute: (t: Prisma.TransactionClient, initiator: Actor, req: ApprovalRequest, approvers: string, decider: Actor) => Promise<void>;
  /** A step was approved and the request moved on to the next one. */
  onAdvanced?: (t: Prisma.TransactionClient, req: ApprovalRequest, nextOrder: number) => Promise<void>;
  onRejected?: (t: Prisma.TransactionClient, actor: Actor, req: ApprovalRequest, comment: string) => Promise<void>;
  onCancelled?: (t: Prisma.TransactionClient, actor: Actor, req: ApprovalRequest) => Promise<void>;
};

async function handlerFor(action: ApprovalAction): Promise<Handler> {
  const { approvalHandlers } = await import('./approval-handlers');
  return approvalHandlers[action];
}

export async function actorForUser(db: Db, userId: string, orgId?: string | null): Promise<Actor> {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { location: true } });
  const scopeIdPath = u.role === 'BRANCH_USER' ? u.location?.idPath ?? null : null;
  const org = await resolveOrg(db, { role: u.role, scopeIdPath }, orgId);
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    locationId: u.role === 'BRANCH_USER' ? u.locationId : null, scopeIdPath, scopeName: u.location?.namePath ?? null,
    orgId: org?.id ?? null, orgIdPath: org?.idPath ?? null, orgName: org?.name ?? null,
    employeeId: u.employeeId,
  };
}

export async function decide(actor: Actor, requestId: string, decision: 'APPROVE' | 'REJECT', comment?: string | null) {
  if (decision === 'REJECT' && !comment?.trim()) throw badRequest('A comment is required to reject.', [{ field: 'comment', message: 'Required when rejecting' }]);
  return tx(async (t) => {
    await t.$queryRaw`SELECT id FROM approval_requests WHERE id = ${requestId} FOR UPDATE`;
    const req = await t.approvalRequest.findUnique({ where: { id: requestId }, include: { tasks: true } });
    if (!req) throw notFound('Approval request');
    if (req.status !== 'PENDING') throw conflict(`${req.requestNo} is already ${req.status.toLowerCase()}.`);
    if (!(await canSeeRequest(actor, req))) throw notFound('Approval request');
    const task = req.tasks.find((x) => x.stepOrder === req.currentOrder && canActOnTask(actor, req, x));
    if (!task) {
      if (req.initiatorId === actor.id && actor.role !== 'ADMIN') throw forbidden('You cannot approve or reject your own request.');
      throw forbidden('You are not an approver for the current step of this request.');
    }
    await t.approvalTask.update({ where: { id: task.id }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: actor.id, decidedByName: actor.name, decidedAt: new Date(), comment: comment ?? null } });
    await audit(t, actor, { action: decision === 'APPROVE' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED', entityType: 'ApprovalRequest', entityId: req.id, entityLabel: req.requestNo, details: { step: req.currentOrder, comment, action: req.action, summary: req.summary }, locationIds: req.locationIds });
    const handler = await handlerFor(req.action);

    if (decision === 'REJECT') {
      await t.approvalTask.updateMany({ where: { requestId: req.id, status: { in: ['PENDING', 'WAITING'] } }, data: { status: 'SKIPPED' } });
      const updated = await t.approvalRequest.update({ where: { id: req.id }, data: { status: 'REJECTED', decidedAt: new Date() } });
      await handler.onRejected?.(t, actor, updated, comment!);
      await notifyUsers(t, [req.initiatorId], { type: req.action === 'TRANSFER' ? 'TRANSFER_DECIDED' : 'APPROVAL_DECIDED', title: `Rejected: ${req.summary}`, body: `${actor.name} rejected ${req.requestNo}: ${comment}`, link: `/approvals?request=${req.id}`, eventKey: `approval:${req.id}:rejected` });
      return { status: 'REJECTED' as const, requestNo: req.requestNo };
    }

    const remainingInOrder = await t.approvalTask.count({ where: { requestId: req.id, stepOrder: req.currentOrder, status: 'PENDING' } });
    if (remainingInOrder > 0) return { status: 'PENDING' as const, requestNo: req.requestNo };
    const next = await t.approvalTask.findFirst({ where: { requestId: req.id, status: 'WAITING' }, orderBy: { stepOrder: 'asc' } });
    if (next) {
      await t.approvalTask.updateMany({ where: { requestId: req.id, stepOrder: next.stepOrder }, data: { status: 'PENDING' } });
      await t.approvalRequest.update({ where: { id: req.id }, data: { currentOrder: next.stepOrder } });
      await handler.onAdvanced?.(t, req, next.stepOrder);
      await notifyApprovers(t, req.id);
      return { status: 'PENDING' as const, requestNo: req.requestNo };
    }
    const approved = await t.approvalRequest.update({ where: { id: req.id }, data: { status: 'APPROVED', decidedAt: new Date() } });
    const approvers = (await t.approvalTask.findMany({ where: { requestId: req.id, status: 'APPROVED' }, select: { decidedByName: true } })).map((x) => x.decidedByName).filter(Boolean).join(', ');
    const initiator = await actorForUser(t, req.initiatorId);
    await handler.execute(t, initiator, approved, approvers, actor);
    await audit(t, actor, { action: 'APPROVAL_EXECUTED', entityType: 'ApprovalRequest', entityId: req.id, entityLabel: req.requestNo, details: { action: req.action, approvers }, locationIds: req.locationIds });
    await notifyUsers(t, [req.initiatorId], { type: req.action === 'TRANSFER' ? 'TRANSFER_DECIDED' : 'APPROVAL_DECIDED', title: `Approved: ${req.summary}`, body: `${req.requestNo} was approved by ${approvers} and has been applied.`, link: `/approvals?request=${req.id}`, eventKey: `approval:${req.id}:approved` });
    return { status: 'APPROVED' as const, requestNo: req.requestNo };
  }, { timeoutMs: 120_000 });
}

export async function bulkDecide(actor: Actor, requestIds: string[], decision: 'APPROVE' | 'REJECT', comment?: string) {
  const results = [];
  for (const id of requestIds) {
    try {
      results.push({ id, ...(await decide(actor, id, decision, comment)), ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: (e as Error).message });
    }
  }
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

export async function reassignTask(actor: Actor, requestId: string, toUserId: string, comment?: string) {
  return tx(async (t) => {
    const req = await t.approvalRequest.findUnique({ where: { id: requestId }, include: { tasks: true } });
    if (!req || req.status !== 'PENDING') throw notFound('Pending approval request');
    const task = req.tasks.find((x) => x.status === 'PENDING' && (canActOnTask(actor, req, x) || actor.role === 'ADMIN'));
    if (!task) throw forbidden('You cannot reassign this request.');
    const to = await t.user.findUnique({ where: { id: toUserId } });
    if (!to || !to.active) throw badRequest('The selected user does not exist or is inactive.');
    if (to.id === req.initiatorId && to.role !== 'ADMIN') throw badRequest('A request cannot be reassigned to its initiator.');
    if (req.action === 'TRANSFER' && to.role === 'BRANCH_USER' && task.stepOrder === 1) throw badRequest('The first transfer approval is given by an Administrator.');
    await t.approvalTask.update({ where: { id: task.id }, data: { approverType: 'USER', approverUserId: to.id, approverRole: null, reassignedFromUserId: actor.id, comment: comment ?? null } });
    await audit(t, actor, { action: 'APPROVAL_REASSIGNED', entityType: 'ApprovalRequest', entityId: req.id, entityLabel: req.requestNo, details: { to: to.email, comment }, locationIds: req.locationIds });
    await notifyUsers(t, [to.id], { type: 'APPROVAL_REQUESTED', title: `Approval reassigned to you: ${req.summary}`, body: `${actor.name} reassigned ${req.requestNo} to you.`, link: `/approvals?request=${req.id}`, eventKey: `approval:${req.id}:reassign:${task.id}:${to.id}` });
    return { ok: true };
  });
}

export async function cancelRequest(actor: Actor, requestId: string) {
  return tx(async (t) => {
    const req = await t.approvalRequest.findUnique({ where: { id: requestId }, include: { tasks: true } });
    if (!req) throw notFound('Approval request');
    if (req.initiatorId !== actor.id && actor.role !== 'ADMIN') throw forbidden('Only the initiator can cancel this request.');
    if (req.status !== 'PENDING') throw conflict(`${req.requestNo} is already ${req.status.toLowerCase()}.`);
    if (req.tasks.some((x) => x.decidedAt)) throw conflict('The request can no longer be cancelled because a decision has already been made.');
    await t.approvalTask.updateMany({ where: { requestId: req.id }, data: { status: 'SKIPPED' } });
    const u = await t.approvalRequest.update({ where: { id: req.id }, data: { status: 'CANCELLED', decidedAt: new Date() } });
    await (await handlerFor(req.action)).onCancelled?.(t, actor, u);
    await audit(t, actor, { action: 'APPROVAL_CANCELLED', entityType: 'ApprovalRequest', entityId: req.id, entityLabel: req.requestNo, locationIds: req.locationIds });
    return { ok: true };
  });
}

// ───────────── Visibility / inbox (FR-APR-05) ─────────────

export async function canSeeRequest(actor: Actor, req: Pick<ApprovalRequest, 'initiatorId' | 'locationIds'> & { tasks?: { approverUserId: string | null }[] }) {
  if (actor.role !== 'BRANCH_USER') return true;
  if (req.initiatorId === actor.id) return true;
  // A named approver (a destination's location manager) sees the request they decide.
  if (req.tasks?.some((x) => x.approverUserId === actor.id)) return true;
  if (!req.locationIds.length) return false;
  const locs = await prisma.location.findMany({ where: { id: { in: req.locationIds } }, select: { idPath: true } });
  return locs.length > 0 && locs.every((l) => l.idPath.startsWith(actor.scopeIdPath ?? '/__none__/'));
}

export async function listRequests(actor: Actor, p: { status?: string; action?: string; mine?: boolean; actionable?: boolean; skip: number; take: number }) {
  const where: Prisma.ApprovalRequestWhereInput = {
    ...(p.status ? { status: p.status as ApprovalRequest['status'] } : {}),
    ...(p.action ? { action: p.action as ApprovalAction } : {}),
    ...(p.mine ? { initiatorId: actor.id } : {}),
  };
  if (actor.role === 'BRANCH_USER') {
    // Branch users see requests they raised, or that concern only their own branch.
    const scopeIds = (await prisma.location.findMany({ where: { idPath: { startsWith: actor.scopeIdPath! } }, select: { id: true } })).map((l) => l.id);
    where.OR = [{ initiatorId: actor.id }, { locationIds: { hasSome: scopeIds } }, { tasks: { some: { approverUserId: actor.id } } }];
  }
  const rows = await prisma.approvalRequest.findMany({ where, include: { tasks: { orderBy: { stepOrder: 'asc' } } }, orderBy: { createdAt: 'desc' }, skip: p.actionable ? 0 : p.skip, take: p.actionable ? 5000 : p.take });
  let visible = [];
  for (const r of rows) if (await canSeeRequest(actor, r)) visible.push({ ...r, canAct: r.status === 'PENDING' && r.tasks.some((x) => x.stepOrder === r.currentOrder && canActOnTask(actor, r, x)), canCancel: r.status === 'PENDING' && (r.initiatorId === actor.id || actor.role === 'ADMIN') && !r.tasks.some((x) => x.decidedAt) });
  if (p.actionable) visible = visible.filter((r) => r.canAct);
  const total = p.actionable ? visible.length : await prisma.approvalRequest.count({ where });
  return { rows: p.actionable ? visible.slice(p.skip, p.skip + p.take) : visible, total };
}

export async function inboxCounts(actor: Actor) {
  const pending = await prisma.approvalRequest.findMany({ where: { status: 'PENDING' }, include: { tasks: true } });
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of pending) {
    if (r.tasks.some((x) => x.stepOrder === r.currentOrder && canActOnTask(actor, r, x))) {
      counts[r.action] = (counts[r.action] ?? 0) + 1;
      total++;
    }
  }
  return { total, byAction: counts };
}

export async function getRequest(actor: Actor, id: string) {
  const r = await prisma.approvalRequest.findUnique({ where: { id }, include: { tasks: { orderBy: { stepOrder: 'asc' } } } });
  if (!r || !(await canSeeRequest(actor, r))) throw notFound('Approval request');
  const userIds = r.tasks.map((x) => x.approverUserId).filter((x): x is string => !!x);
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return {
    ...r,
    tasks: r.tasks.map((x) => ({ ...x, approverName: x.approverUserId ? names.get(x.approverUserId) : null })),
    canAct: r.status === 'PENDING' && r.tasks.some((x) => x.stepOrder === r.currentOrder && canActOnTask(actor, r, x)),
    canCancel: r.status === 'PENDING' && (r.initiatorId === actor.id || actor.role === 'ADMIN') && !r.tasks.some((x) => x.decidedAt),
  };
}
