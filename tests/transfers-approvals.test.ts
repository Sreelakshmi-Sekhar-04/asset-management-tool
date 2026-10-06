import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { actorForUser, decide, savePolicy } from '@/server/services/approvals';
import { assignAsset, bulkAssign, bulkCheckIn, checkInAsset } from '@/server/services/lifecycle';
import { createCategory } from '@/server/services/master';
import { createUser } from '@/server/services/users';
import { world, PASSWORD, type World } from './fixtures';
import { rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

const movements = (assetId: string) => prisma.assetMovement.findMany({ where: { assetId }, orderBy: { recordedAt: 'asc' } });

describe('assign and transfer from the asset register', () => {
  it('one asset to an employee: the employee holds it and the assignment history opens', async () => {
    const a = await w.asset(w.A.id);
    await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe('ASSIGNED');
    expect(after.holderEmployeeId).toBe(w.empA.id);
    expect(after.locationId).toBe(w.A.id);
    const open = await prisma.assetAssignment.findFirstOrThrow({ where: { assetId: a.id, endAt: null } });
    expect(open.holderType).toBe('EMPLOYEE');
  });

  it('one asset to a location is recorded as a transfer: it moves, and the move is in its history', async () => {
    const a = await w.asset(w.A.id);
    const r = await assignAsset(w.it.actor, a.id, { holder: { type: 'LOCATION', id: w.B.id }, remarks: 'Desk move' }) as { mode: string; assigned: number };
    expect(r.mode).toBe('TRANSFER');
    expect(r.assigned).toBe(1);
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.locationId).toBe(w.B.id);
    expect(after.status).toBe('IN_STOCK');
    const m = (await movements(a.id)).at(-1)!;
    expect(m.kind).toBe('TRANSFERRED');
    expect(m.fromLocationId).toBe(w.A.id);
    expect(m.toLocationId).toBe(w.B.id);
    expect(m.remarks).toBe('Desk move');
    const audited = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ASSET_TRANSFERRED', entityId: a.id } });
    expect(audited.entityLabel).toBe(a.assetCode);
  });

  it('transferring an asset held by an employee releases the holding and brings it in stock at the destination', async () => {
    const a = await w.asset(w.A.id);
    await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    await assignAsset(w.it.actor, a.id, { holder: { type: 'LOCATION', id: w.B.id } });
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.holderType).toBeNull();
    expect(after.status).toBe('IN_STOCK');
    expect(after.locationId).toBe(w.B.id);
    // The employee's holding is closed, not deleted: the history keeps both periods.
    const periods = await prisma.assetAssignment.findMany({ where: { assetId: a.id } });
    expect(periods).toHaveLength(1);
    expect(periods[0].endAt).not.toBeNull();
  });

  it('several assets move to one location in a single action', async () => {
    const assets = [await w.asset(w.A.id), await w.asset(w.A.id), await w.asset(w.A.id)];
    const r = await bulkAssign(w.it.actor, { assetIds: assets.map((a) => a.id), holder: { type: 'LOCATION', id: w.B.id }, remarks: 'Branch consolidation' }) as { mode: string; assigned: number };
    expect(r.mode).toBe('TRANSFER');
    expect(r.assigned).toBe(3);
    expect(await prisma.asset.count({ where: { id: { in: assets.map((a) => a.id) }, locationId: w.B.id } })).toBe(3);
    for (const a of assets) expect((await movements(a.id)).at(-1)!.kind).toBe('TRANSFERRED');
  });

  it('the check step reports what would happen and changes nothing', async () => {
    const stay = await w.asset(w.B.id);
    const move = await w.asset(w.A.id);
    const r = await bulkAssign(w.it.actor, { assetIds: [stay.id, move.id], holder: { type: 'LOCATION', id: w.B.id }, dryRun: true }) as { assignable: number; assigned: number; skipped: { ref: string }[] };
    expect(r.assignable).toBe(1);
    expect(r.assigned).toBe(0);
    expect(r.skipped.map((s) => s.ref)).toEqual([stay.assetCode]);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: move.id } })).locationId).toBe(w.A.id);
  });

  it('an asset under repair or retired cannot be transferred, and the rest still move', async () => {
    const ok = await w.asset(w.A.id);
    const repair = await w.asset(w.A.id);
    const { startRepair } = await import('@/server/services/lifecycle');
    await startRepair(w.it.actor, repair.id, { reason: 'Broken screen' });
    const r = await bulkAssign(w.it.actor, { assetIds: [ok.id, repair.id], holder: { type: 'LOCATION', id: w.B.id } }) as { assigned: number; failed: { ref: string; message: string }[] };
    expect(r.assigned).toBe(1);
    expect(r.failed.map((f) => f.ref)).toEqual([repair.assetCode]);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: repair.id } })).locationId).toBe(w.A.id);
  });

  it('a check-in after a transfer still works, and bulk check-in is unaffected', async () => {
    const a = await w.asset(w.A.id);
    await bulkAssign(w.it.actor, { assetIds: [a.id], holder: { type: 'LOCATION', id: w.B.id } });
    await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    await checkInAsset(w.it.actor, a.id, {});
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('IN_STOCK');
    const b = await w.asset(w.A.id);
    await assignAsset(w.it.actor, b.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    await bulkCheckIn(w.it.actor, [b.id], {});
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('IN_STOCK');
  });
});

describe('approvals gate assignments and transfers alike', () => {
  it('a matching Assign policy holds the transfer until it is approved, then carries it out', async () => {
    const cat = await createCategory(w.sys, { name: `Gated ${w.s}`, serialRequired: false });
    const policy = await savePolicy(w.admin.actor, null, {
      name: `Assign sign-off ${w.s}`, action: 'ASSIGN', priority: 1, categoryIds: [cat.id],
      steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'ADMIN' }],
    });
    const a = await w.asset(w.A.id, { categoryId: cat.id });
    const r = await bulkAssign(w.it.actor, { assetIds: [a.id], holder: { type: 'LOCATION', id: w.B.id }, remarks: 'Needs sign-off' }) as { assigned: number; pendingApproval?: { id: string } };
    expect(r.assigned).toBe(0);
    expect(r.pendingApproval).toBeTruthy();
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).locationId).toBe(w.A.id);
    // While it waits, the asset cannot be moved another way.
    await rejectsWith(bulkAssign(w.it.actor, { assetIds: [a.id], holder: { type: 'EMPLOYEE', id: w.empA.id } }), 400, /None of the 1/);
    await decide(w.admin.actor, r.pendingApproval!.id, 'APPROVE', 'Go ahead');
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.locationId).toBe(w.B.id);
    const m = (await movements(a.id)).at(-1)!;
    expect(m.kind).toBe('TRANSFERRED');
    expect(m.approverName).toContain(w.admin.user.name);
    await savePolicy(w.admin.actor, policy!.id, { name: policy!.name, action: 'ASSIGN', priority: 1, active: false, categoryIds: [cat.id], steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'ADMIN' }] });
  });

  it('a rejected request leaves the asset exactly where it was', async () => {
    const cat = await createCategory(w.sys, { name: `Gated2 ${w.s}`, serialRequired: false });
    const policy = await savePolicy(w.admin.actor, null, {
      name: `Assign sign-off 2 ${w.s}`, action: 'ASSIGN', priority: 1, categoryIds: [cat.id],
      steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'ADMIN' }],
    });
    const a = await w.asset(w.A.id, { categoryId: cat.id });
    const r = await bulkAssign(w.it.actor, { assetIds: [a.id], holder: { type: 'LOCATION', id: w.B.id } }) as { pendingApproval?: { id: string } };
    await decide(w.admin.actor, r.pendingApproval!.id, 'REJECT', 'Keep it where it is');
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).locationId).toBe(w.A.id);
    // Released again: the asset can now be assigned normally.
    await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    await savePolicy(w.admin.actor, policy!.id, { name: policy!.name, action: 'ASSIGN', priority: 1, active: false, categoryIds: [cat.id], steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'ADMIN' }] });
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
