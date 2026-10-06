import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { assignAsset, bulkAssign, startRepair } from '@/server/services/lifecycle';
import { createEmployee } from '@/server/services/employees';
import { listPeople } from '@/server/services/people';
import { createTransfer } from '@/server/services/transfers';
import { updateUser } from '@/server/services/users';
import { world, type World } from './fixtures';
import { rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

describe('assign many assets at once', () => {
  it('assigns every selected asset in one go, with history and audit per asset', async () => {
    const assets = await Promise.all([1, 2, 3, 4, 5].map(() => w.asset(w.A.id)));
    const r = await bulkAssign(w.it.actor, { assetIds: assets.map((a) => a.id), holder: { type: 'EMPLOYEE', id: w.empA.id }, remarks: 'New joiner kit' });
    expect(r.assigned).toBe(5);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toEqual([]);
    const after = await prisma.asset.findMany({ where: { id: { in: assets.map((a) => a.id) } } });
    expect(after.every((a) => a.status === 'ASSIGNED' && a.holderEmployeeId === w.empA.id)).toBe(true);
    for (const a of assets) {
      expect(await prisma.assetAssignment.count({ where: { assetId: a.id, holderType: 'EMPLOYEE', holderId: w.empA.id, endAt: null } })).toBe(1);
      expect(await prisma.assetMovement.count({ where: { assetId: a.id, kind: 'ASSIGNED' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityId: a.id, action: 'ASSET_ASSIGNED' } })).toBe(1);
    }
  });

  it('a check run changes nothing, and repeating the assignment skips assets already with that holder', async () => {
    const assets = await Promise.all([1, 2].map(() => w.asset(w.A.id)));
    const sel = { assetIds: assets.map((a) => a.id), holder: { type: 'EMPLOYEE', id: w.empA.id } };
    const dry = await bulkAssign(w.it.actor, { ...sel, dryRun: true });
    expect(dry).toMatchObject({ assignable: 2, assigned: 0 });
    expect(await prisma.asset.count({ where: { id: { in: sel.assetIds }, status: 'ASSIGNED' } })).toBe(0);
    await bulkAssign(w.it.actor, sel);
    await rejectsWith(bulkAssign(w.it.actor, sel), 400, /None of the 2/);
    expect(await prisma.assetAssignment.count({ where: { assetId: { in: sel.assetIds } } })).toBe(2);
  });

  it('assigns what it can and lists each asset it could not', async () => {
    const ok = await w.asset(w.A.id);
    const repair = await w.asset(w.A.id);
    await startRepair(w.it.actor, repair.id, { reason: 'Broken screen' });
    const moving = await w.asset(w.A.id);
    await createTransfer(w.it.actor, { fromLocationId: w.A.id, toLocationId: w.B.id, reason: 'Move', assetIds: [moving.id] });
    const already = await w.asset(w.A.id);
    await assignAsset(w.it.actor, already.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    const r = await bulkAssign(w.it.actor, { assetIds: [ok.id, repair.id, moving.id, already.id], holder: { type: 'EMPLOYEE', id: w.empA.id } });
    expect(r.assigned).toBe(1);
    expect(r.skipped.map((p) => p.ref)).toEqual([already.assetCode]);
    expect(r.failed.map((p) => p.ref).sort()).toEqual([repair.assetCode, moving.assetCode].sort());
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: repair.id } })).status).toBe('UNDER_REPAIR');
  });

  it('can assign to a location or department as well as an employee', async () => {
    const a = await w.asset(w.A.id);
    const r = await bulkAssign(w.it.actor, { assetIds: [a.id], holder: { type: 'DEPARTMENT', id: w.dept.id } });
    expect(r.assigned).toBe(1);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).holderDepartmentId).toBe(w.dept.id);
  });
});

describe('one list of users and employees', () => {
  it('shows a linked user and employee as one person, and sign-in-only users on their own row', async () => {
    const linked = await createEmployee(w.sys, { employeeCode: `EL${w.s}`, name: `Linked ${w.s}`, departmentId: w.dept.id, locationId: w.A.id });
    await updateUser(w.admin.actor, w.it.user.id, { email: w.it.user.email, name: w.it.user.name, role: 'IT_OPERATOR', employeeId: linked.id });
    const page = await listPeople(w.admin.actor, { name: w.s, skip: 0, take: 100, active: 'all' });
    const rows = page.rows;
    const person = rows.filter((r) => r.employeeId === linked.id);
    expect(person).toHaveLength(1);
    expect(person[0].userId).toBe(w.it.user.id);
    expect(rows.filter((r) => r.userId === w.it.user.id)).toHaveLength(1);
    expect(rows.some((r) => r.userId === w.admin.user.id && r.employeeId === null)).toBe(true);
    expect(rows.some((r) => r.employeeId === w.empA.id && r.userId === null)).toBe(true);
  });

  it('combines column filters', async () => {
    const both = await listPeople(w.admin.actor, { name: w.s, signIn: 'NONE', locationId: w.A.id, skip: 0, take: 100 });
    expect(both.rows.length).toBeGreaterThan(0);
    expect(both.rows.every((r) => r.userId === null && r.location?.includes(`Branch A ${w.s}`))).toBe(true);
    const admins = await listPeople(w.admin.actor, { name: w.s, signIn: 'ADMIN', skip: 0, take: 100 });
    expect(admins.rows.map((r) => r.userId)).toEqual([w.admin.user.id]);
  });

  it('branch users see only employees of their own branch, without sign-in details', async () => {
    const page = await listPeople(w.brA.actor, { skip: 0, take: 500 });
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.employeeId && r.location?.includes(`Branch A ${w.s}`) && r.userId === null && r.role === null)).toBe(true);
  });
});
