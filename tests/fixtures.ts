import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR, type Actor } from '@/server/actor';
import { invalidateSettings } from '@/server/settings';
import { actorForUser } from '@/server/services/approvals';
import { createAsset } from '@/server/services/assets';
import { createEmployee } from '@/server/services/employees';
import { createLocation } from '@/server/services/locations';
import { createCategory, createDepartment } from '@/server/services/master';
import { createUser } from '@/server/services/users';

export const PASSWORD = 'Test#Pass2026!';
let n = 0;
const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

/**
 * A small, isolated organization per test file: one organization (the root of the location
 * tree) with two states and three branches (A and B in state 1, C in state 2), an admin, an IT
 * operator, a branch user for A and one for C, a category, a department and an employee per
 * branch. Every name carries a unique suffix so files never collide in the shared test DB, and
 * every actor is bound to this world's organization, so one file never sees another's data.
 */
export async function world() {
  const s = uid();
  const sys: Actor = { ...SYSTEM_ACTOR, name: 'Test setup' };
  invalidateSettings();
  const region = await createLocation(sys, { name: `Region ${s}`, type: 'ORGANIZATION', parentId: null });
  const orgActor = (a: Actor): Actor => ({ ...a, orgId: region.id, orgIdPath: region.idPath, orgName: region.name });
  const st1 = await createLocation(sys, { name: `State1 ${s}`, type: 'STATE', state: `State1-${s}`, parentId: region.id });
  const st2 = await createLocation(sys, { name: `State2 ${s}`, type: 'STATE', state: `State2-${s}`, parentId: region.id });
  const A = await createLocation(sys, { name: `Branch A ${s}`, type: 'BRANCH', parentId: st1.id });
  const B = await createLocation(sys, { name: `Branch B ${s}`, type: 'BRANCH', parentId: st1.id });
  const C = await createLocation(sys, { name: `Branch C ${s}`, type: 'BRANCH', parentId: st2.id });
  const cat = await createCategory(sys, { name: `Laptop ${s}`, serialRequired: true });
  const dept = await createDepartment(orgActor(sys), { name: `Ops ${s}` });
  const mk = async (prefix: string, role: 'ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER', locationId?: string) => {
    const u = await createUser(sys, { email: `${prefix}.${s}@test.example.com`, name: `${prefix} ${s}`, role, locationId: locationId ?? null, password: PASSWORD, sendInvite: false });
    return { user: u, actor: await actorForUser(prisma, u.id, region.id) };
  };
  const admin = await mk('admin', 'ADMIN');
  const it = await mk('it', 'IT_OPERATOR');
  const brA = await mk('branch-a', 'BRANCH_USER', A.id);
  const brC = await mk('branch-c', 'BRANCH_USER', C.id);
  const empA = await createEmployee(sys, { employeeCode: `EA${s}`, name: `Emp A ${s}`, departmentId: dept.id, locationId: A.id });
  const empC = await createEmployee(sys, { employeeCode: `EC${s}`, name: `Emp C ${s}`, departmentId: dept.id, locationId: C.id });
  let serial = 0;
  const asset = async (locationId: string, extra: Record<string, unknown> = {}) => {
    const r = await createAsset(it.actor, { categoryId: cat.id, make: 'Dell', model: 'Latitude 5440', serialNumber: `SN-${s}-${serial++}`, locationId, purchaseCost: 50000, ...extra });
    if (!('asset' in r)) throw new Error('asset creation unexpectedly went to approval');
    if (!r.asset) throw new Error('asset not created');
    return r.asset;
  };
  return { s, sys: orgActor(sys), org: region, region, st1, st2, A, B, C, cat, dept, admin, it, brA, brC, empA, empC, asset, orgActor };
}
export type World = Awaited<ReturnType<typeof world>>;
