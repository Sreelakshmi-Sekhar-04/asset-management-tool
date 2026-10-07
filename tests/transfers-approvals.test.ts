import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { actorForUser, cancelRequest, decide, getRequest, listRequests } from '@/server/services/approvals';
import { listAssets } from '@/server/services/assets';
import { assignAsset, bulkAssign, bulkCheckIn, checkInAsset } from '@/server/services/lifecycle';
import { createLocation, updateLocation } from '@/server/services/locations';
import { createUser } from '@/server/services/users';
import { world, PASSWORD, type World } from './fixtures';
import { rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

const movements = (assetId: string) => prisma.assetMovement.findMany({ where: { assetId }, orderBy: { recordedAt: 'asc' } });
const asset = (id: string) => prisma.asset.findUniqueOrThrow({ where: { id } });
type Result = { mode: string; assigned: number; assignable: number; pendingApproval?: { id: string; requestNo: string }; failed: { ref: string; message: string }[]; skipped: { ref: string }[]; approvals?: string[] };
const transfer = async (assetIds: string[], to: string, remarks?: string) => bulkAssign(w.it.actor, { assetIds, holder: { type: 'LOCATION', id: to }, remarks }) as Promise<Result>;

describe('assign to an employee is an assignment', () => {
  it('one asset to an employee: assigned at once, with no transfer approval', async () => {
    const a = await w.asset(w.A.id);
    const r = await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } }) as { asset?: unknown };
    expect(r.asset).toBeTruthy();
    const after = await asset(a.id);
    expect(after.status).toBe('ASSIGNED');
    expect(after.holderEmployeeId).toBe(w.empA.id);
    expect(after.locationId).toBe(w.A.id);
    expect(after.transferStatus).toBe('NONE');
    expect(await prisma.approvalRequest.count({ where: { assetIds: { has: a.id } } })).toBe(0);
    const open = await prisma.assetAssignment.findFirstOrThrow({ where: { assetId: a.id, endAt: null } });
    expect(open.holderType).toBe('EMPLOYEE');
  });
});

describe('assign to a location is a transfer with two approvals', () => {
  it('one asset: Pending admin approval, then Pending location manager approval, then Transferred', async () => {
    const a = await w.asset(w.A.id);
    const r = await assignAsset(w.it.actor, a.id, { holder: { type: 'LOCATION', id: w.B.id }, remarks: 'Desk move' }) as Result;
    expect(r.mode).toBe('TRANSFER');
    expect(r.assigned).toBe(0);
    expect(r.pendingApproval).toBeTruthy();
    const req = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.pendingApproval!.id }, include: { tasks: { orderBy: { stepOrder: 'asc' } } } });
    expect(req.action).toBe('TRANSFER');
    expect(req.tasks.map((t) => [t.stepOrder, t.approverType, t.approverRole ?? t.approverUserId, t.status])).toEqual([
      [1, 'ROLE', 'ADMIN', 'PENDING'], [2, 'USER', w.brB.user.id, 'WAITING'],
    ]);
    // Nothing moved: the asset stays where it was until both approvals are given.
    let now = await asset(a.id);
    expect(now).toMatchObject({ locationId: w.A.id, status: 'IN_STOCK', transferStatus: 'PENDING_ADMIN', transferRequestId: req.id });

    await decide(w.admin.actor, req.id, 'APPROVE', 'OK from admin');
    now = await asset(a.id);
    expect(now).toMatchObject({ locationId: w.A.id, transferStatus: 'PENDING_LOCATION_MANAGER' });
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('PENDING');

    await decide(w.brB.actor, req.id, 'APPROVE', 'Received');
    now = await asset(a.id);
    expect(now).toMatchObject({ locationId: w.B.id, status: 'IN_STOCK', transferStatus: 'APPROVED' });
    const m = (await movements(a.id)).at(-1)!;
    expect(m.kind).toBe('TRANSFERRED');
    expect(m.fromLocationId).toBe(w.A.id);
    expect(m.toLocationId).toBe(w.B.id);
    expect(m.remarks).toBe('Desk move');
    expect(m.approverName).toContain(w.admin.user.name);
    expect(m.approverName).toContain(w.brB.user.name);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'ASSET_TRANSFERRED', entityId: a.id } })).entityLabel).toBe(a.assetCode);
  });

  it('many assets: one bulk transfer request, and every asset moves only after both approvals', async () => {
    const assets = [await w.asset(w.A.id), await w.asset(w.A.id), await w.asset(w.A.id), await w.asset(w.A.id), await w.asset(w.A.id)];
    const ids = assets.map((a) => a.id);
    const r = await transfer(ids, w.B.id, 'Branch consolidation');
    expect(r.mode).toBe('TRANSFER');
    expect(r.assignable).toBe(5);
    expect(await prisma.asset.count({ where: { id: { in: ids }, transferStatus: 'PENDING_ADMIN', locationId: w.A.id } })).toBe(5);
    await decide(w.admin.actor, r.pendingApproval!.id, 'APPROVE');
    expect(await prisma.asset.count({ where: { id: { in: ids }, transferStatus: 'PENDING_LOCATION_MANAGER', locationId: w.A.id } })).toBe(5);
    await decide(w.brB.actor, r.pendingApproval!.id, 'APPROVE');
    expect(await prisma.asset.count({ where: { id: { in: ids }, transferStatus: 'APPROVED', locationId: w.B.id } })).toBe(5);
    for (const a of assets) expect((await movements(a.id)).at(-1)!.kind).toBe('TRANSFERRED');
  });

  it('a rejection by the administrator stops the transfer; the asset stays where it was', async () => {
    const a = await w.asset(w.A.id);
    const r = await transfer([a.id], w.B.id);
    await decide(w.admin.actor, r.pendingApproval!.id, 'REJECT', 'Not needed');
    const after = await asset(a.id);
    expect(after).toMatchObject({ locationId: w.A.id, status: 'IN_STOCK', transferStatus: 'REJECTED' });
    expect((await prisma.approvalTask.findFirstOrThrow({ where: { requestId: r.pendingApproval!.id, stepOrder: 2 } })).status).toBe('SKIPPED');
    expect((await movements(a.id)).some((m) => m.kind === 'TRANSFERRED')).toBe(false);
    // The listing explains the rejection.
    const { rows } = await listAssets(w.it.actor, { ids: [a.id] }, { skip: 0, take: 5 });
    expect(rows[0].transfer).toMatchObject({ requestNo: r.pendingApproval!.requestNo, reason: 'Not needed', rejectedBy: w.admin.user.name });
    // Released again: the asset can now be assigned normally.
    await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
  });

  it('a rejection by the destination location manager leaves the asset at its original location', async () => {
    const a = await w.asset(w.A.id);
    await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    const r = await transfer([a.id], w.B.id);
    await decide(w.admin.actor, r.pendingApproval!.id, 'APPROVE');
    await decide(w.brB.actor, r.pendingApproval!.id, 'REJECT', 'No space at B');
    const after = await asset(a.id);
    // Not even partly moved: location, holder and status are untouched.
    expect(after).toMatchObject({ locationId: w.A.id, status: 'ASSIGNED', holderEmployeeId: w.empA.id, transferStatus: 'REJECTED' });
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.pendingApproval!.id } })).status).toBe('REJECTED');
  });

  it('there is no automatic approval, and each step can only be given by its own approver', async () => {
    const a = await w.asset(w.A.id);
    const r = await transfer([a.id], w.B.id);
    const id = r.pendingApproval!.id;
    // The initiator (an IT operator), the destination's manager and another branch cannot give step 1.
    await rejectsWith(decide(w.it.actor, id, 'APPROVE'), 403);
    await rejectsWith(decide(w.brB.actor, id, 'APPROVE'), 403);
    await rejectsWith(decide(w.brC.actor, id, 'APPROVE'), 404);
    await decide(w.admin.actor, id, 'APPROVE');
    // Step 2 belongs to B's manager, not to the administrator or another branch's manager.
    await rejectsWith(decide(w.admin.actor, id, 'APPROVE'), 403);
    await rejectsWith(decide(w.brA.actor, id, 'APPROVE'), 404);
    expect((await asset(a.id)).locationId).toBe(w.A.id);
    // B's manager sees it waiting for them.
    const inbox = await listRequests(w.brB.actor, { actionable: true, skip: 0, take: 20 });
    expect(inbox.rows.map((x) => x.id)).toContain(id);
    expect((await getRequest(w.brB.actor, id)).canAct).toBe(true);
    // While it waits, the asset cannot be moved another way.
    await rejectsWith(bulkAssign(w.it.actor, { assetIds: [a.id], holder: { type: 'EMPLOYEE', id: w.empA.id } }), 400, /None of the 1/);
    await decide(w.brB.actor, id, 'APPROVE');
    expect((await asset(a.id)).locationId).toBe(w.B.id);
  });

  it('a withdrawn request clears the transfer status', async () => {
    const a = await w.asset(w.A.id);
    const r = await transfer([a.id], w.B.id);
    await cancelRequest(w.it.actor, r.pendingApproval!.id);
    expect(await asset(a.id)).toMatchObject({ locationId: w.A.id, transferStatus: 'NONE', transferRequestId: null });
  });

  it('the check step names both approvers and changes nothing', async () => {
    const stay = await w.asset(w.B.id);
    const move = await w.asset(w.A.id);
    const r = await bulkAssign(w.it.actor, { assetIds: [stay.id, move.id], holder: { type: 'LOCATION', id: w.B.id }, dryRun: true }) as Result;
    expect(r.assignable).toBe(1);
    expect(r.skipped.map((s) => s.ref)).toEqual([stay.assetCode]);
    expect(r.approvals).toEqual(['Admin manager: any Administrator', `Location manager: ${w.brB.user.name} (${w.B.name})`]);
    expect(await asset(move.id)).toMatchObject({ locationId: w.A.id, transferStatus: 'NONE' });
    expect(await prisma.approvalRequest.count({ where: { assetIds: { has: move.id } } })).toBe(0);
  });

  it('the manager comes from the nearest location above when the destination has none; with none at all the transfer is refused', async () => {
    const d = await createLocation(w.sys, { name: `Branch D ${w.s}`, type: 'BRANCH', parentId: w.st1.id });
    const a = await w.asset(w.A.id);
    await rejectsWith(transfer([a.id], d.id), 409, /has no location manager/);
    expect(await asset(a.id)).toMatchObject({ transferStatus: 'NONE' });
    await updateLocation(w.sys, w.org.id, { managerId: w.admin.user.id });
    const r = await transfer([a.id], d.id);
    const step2 = await prisma.approvalTask.findFirstOrThrow({ where: { requestId: r.pendingApproval!.id, stepOrder: 2 } });
    expect(step2.approverUserId).toBe(w.admin.user.id);
    await updateLocation(w.sys, w.org.id, { managerId: null });
  });

  it('assets under repair cannot be transferred; the rest go into the request', async () => {
    const ok = await w.asset(w.A.id);
    const repair = await w.asset(w.A.id);
    const { startRepair } = await import('@/server/services/lifecycle');
    await startRepair(w.it.actor, repair.id, { reason: 'Broken screen' });
    const r = await transfer([ok.id, repair.id], w.B.id);
    expect(r.assignable).toBe(1);
    expect(r.failed.map((f) => f.ref)).toEqual([repair.assetCode]);
    expect(await asset(repair.id)).toMatchObject({ locationId: w.A.id, transferStatus: 'NONE' });
  });

  it('after a transfer the asset can be assigned and checked in as usual', async () => {
    const a = await w.asset(w.A.id);
    const r = await transfer([a.id], w.B.id);
    await decide(w.admin.actor, r.pendingApproval!.id, 'APPROVE');
    await decide(w.brB.actor, r.pendingApproval!.id, 'APPROVE');
    await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    await checkInAsset(w.it.actor, a.id, {});
    expect((await asset(a.id)).status).toBe('IN_STOCK');
    const b = await w.asset(w.A.id);
    await assignAsset(w.it.actor, b.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    await bulkCheckIn(w.it.actor, [b.id], {});
    expect((await asset(b.id)).status).toBe('IN_STOCK');
  });

  it('the asset listing filters by transfer status', async () => {
    const a = await w.asset(w.A.id);
    await transfer([a.id], w.B.id);
    const { rows } = await listAssets(w.it.actor, { transferStatuses: ['PENDING_ADMIN'], ids: [a.id] }, { skip: 0, take: 5 });
    expect(rows.map((x) => x.id)).toEqual([a.id]);
    expect(rows[0]).toMatchObject({ transferStatus: 'PENDING_ADMIN', transfer: { toLocation: w.B.namePath } });
    expect((await listAssets(w.it.actor, { transferStatuses: ['NONE'], ids: [a.id] }, { skip: 0, take: 5 })).total).toBe(0);
  });

  it('a branch user can assign and transfer only inside their own branch', async () => {
    const mine = await w.asset(w.A.id);
    const theirs = await w.asset(w.C.id);
    await rejectsWith(bulkAssign(w.brA.actor, { assetIds: [theirs.id], holder: { type: 'LOCATION', id: w.A.id } }), 400);
    await rejectsWith(bulkAssign(w.brA.actor, { assetIds: [mine.id], holder: { type: 'LOCATION', id: w.C.id } }), 403);
    const u = await createUser(w.sys, { email: `extra.${w.s}@test.example.com`, name: `Extra ${w.s}`, role: 'BRANCH_USER', locationId: w.A.id, password: PASSWORD, sendInvite: false });
    const actor = await actorForUser(prisma, u.id, w.org.id);
    expect(actor.orgId).toBe(w.org.id);
  });
});
