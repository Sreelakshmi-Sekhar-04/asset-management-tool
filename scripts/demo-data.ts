/**
 * The small demo dataset shared by `npm run db:seed` (empty database) and
 * `npm run db:reset-demo` (wipes first). It is deliberately tiny, so the application reloads
 * quickly and every screen is readable:
 *
 *   1 organization, Joy Alukkas (the head quarter)  ·  5 locations (branches under it)
 *   5 departments  ·  5 categories  ·  5 employees  ·  5 assets  ·  3 users  ·  5 warranty renewals
 *
 * Records are created through the application's own services, so each one carries its
 * movements and audit entries, and the demo history includes assignments and a transfer made
 * the way the asset register makes them. More organizations are added, when needed, under
 * Configuration → Organizations.
 */
import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/format';
import { SYSTEM_ACTOR, type Actor } from '@/server/actor';
import { actorForUser, decide } from '@/server/services/approvals';
import { createAsset } from '@/server/services/assets';
import { createEmployee } from '@/server/services/employees';
import { assignAsset } from '@/server/services/lifecycle';
import { createLocation, updateLocation } from '@/server/services/locations';
import { createCategory, createDepartment } from '@/server/services/master';
import { createUser } from '@/server/services/users';

export const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Demo#Pass2026';
export const DOMAIN = 'itam-demo.example.com';

const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

export async function loadDemoData(opts: { actorName: string; adminEmail?: string; adminName?: string }) {
  const today = todayIST();
  const sys: Actor = { ...SYSTEM_ACTOR, name: opts.actorName };

  // ── The organization (head quarter) and its five branches ──
  const org = await createLocation(sys, { name: 'Joy Alukkas', type: 'ORGANIZATION', state: 'Kerala', parentId: null, code: 'JA-HQ' });
  const branch = (name: string, code: string) =>
    createLocation(sys, { name, type: 'BRANCH', state: 'Kerala', parentId: org.id, code, email: null });
  const thrissur = await branch('Thrissur', 'BR01');
  const kochi = await branch('Kochi MG Road', 'BR02');
  const kozhikode = await branch('Kozhikode', 'BR03');
  const tvm = await branch('Thiruvananthapuram', 'BR04');
  await branch('Kannur', 'BR05');

  // ── 5 departments of the organization; 5 categories, shared master data ──
  const asOrg: Actor = { ...sys, orgId: org.id, orgIdPath: org.idPath, orgName: org.name };
  const depts: Record<string, string> = {};
  for (const d of ['Operations', 'Finance', 'IT', 'Sales', 'Human Resources']) depts[d] = (await createDepartment(asOrg, { name: d })).id;
  const cats: Record<string, string> = {};
  for (const [name, serialRequired] of [['Laptop', true], ['Desktop', true], ['Monitor', false], ['Printer', true], ['Mobile phone', true]] as const) {
    cats[name] = (await createCategory(sys, { name, serialRequired })).id;
  }

  // ── 5 employees ──
  const emp = (code: string, name: string, dept: string, locationId: string, email?: string) =>
    createEmployee(asOrg, { employeeCode: code, name, email: email ?? `${name.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`, departmentId: depts[dept], locationId });
  const adminEmail = opts.adminEmail ?? `admin@${DOMAIN}`;
  const adminName = opts.adminName ?? 'Asha Menon';
  const eAdmin = await emp('EMP1001', adminName, 'IT', thrissur.id, adminEmail);
  const eIt = await emp('EMP1002', 'Deepak Nambiar', 'IT', kochi.id, `it@${DOMAIN}`);
  const e1 = await emp('EMP1003', 'Priya Nair', 'Operations', thrissur.id, `br01@${DOMAIN}`);
  const e2 = await emp('EMP1004', 'Rohan Menon', 'Sales', kozhikode.id);
  await emp('EMP1005', 'Ananya Pillai', 'Human Resources', tvm.id);

  // ── 3 users, one per role, each linked to their employee record ──
  const mkUser = (email: string, name: string, role: 'ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER', employeeId: string, locationId: string | null = null) =>
    createUser(sys, { email, name, role, locationId, employeeId, password: DEMO_PASSWORD, sendInvite: false });
  const admin1 = await mkUser(adminEmail, adminName, 'ADMIN', eAdmin.id);
  const it1 = await mkUser(`it@${DOMAIN}`, 'Deepak Nambiar', 'IT_OPERATOR', eIt.id);
  const br1 = await mkUser(`br01@${DOMAIN}`, 'Priya Nair', 'BRANCH_USER', e1.id, thrissur.id);
  const it = await actorForUser(prisma, it1.id, org.id);
  const admin = await actorForUser(prisma, admin1.id, org.id);
  const priya = await actorForUser(prisma, br1.id, org.id);

  // ── Location managers give the second transfer approval: Priya for Thrissur, the
  //    administrator for every other branch (set on the organization, which they inherit) ──
  await updateLocation(sys, thrissur.id, { managerId: br1.id });
  await updateLocation(sys, org.id, { managerId: admin1.id });

  // ── 5 assets across the branches ──
  const mkAsset = async (cat: string, make: string, model: string, serial: string, locationId: string, cost: number, warrantyDays: number, hostname: string | null = null) => {
    const res = await createAsset(it, {
      categoryId: cats[cat], make, model, serialNumber: serial, hostname, locationId,
      purchaseDate: addDays(today, -400), purchaseCost: cost, vendor: 'Redington India',
      warrantyEnd: addDays(today, warrantyDays), condition: 'Good',
    }, { skipApproval: true });
    if (!('asset' in res) || !res.asset) throw new Error(`Could not create the ${cat} asset.`);
    return res.asset.id;
  };
  const laptop = await mkAsset('Laptop', 'Dell', 'Latitude 5440', 'DELAT100001', thrissur.id, 78000, 300, 'BR01-LT-001');
  await mkAsset('Desktop', 'HP', 'ProDesk 400 G9', 'HPPRO100002', thrissur.id, 55000, 25);
  const printer = await mkAsset('Printer', 'HP', 'LaserJet Pro M404dn', 'HPLAS100004', kochi.id, 24000, -20, 'BR02-PR-001');
  const monitor = await mkAsset('Monitor', 'Dell', 'P2422H', 'DEP24100003', kozhikode.id, 16500, 700);
  const phone = await mkAsset('Mobile phone', 'Samsung', 'Galaxy A54', 'SAGAL100005', kozhikode.id, 36000, 120);

  // ── History, made the way the asset register makes it ──
  // Assigned to an employee.
  await assignAsset(it, laptop, { holder: { type: 'EMPLOYEE', id: e1.id }, remarks: 'Demo data' });
  await assignAsset(it, phone, { holder: { type: 'EMPLOYEE', id: e2.id }, remarks: 'Demo data' });
  // Assigned to a location, which is a transfer: the printer moves to Thrissur once the
  // administrator and then Thrissur's manager (Priya) have approved it.
  const moved = await assignAsset(it, printer, { holder: { type: 'LOCATION', id: thrissur.id }, remarks: 'Moved to Thrissur' }) as { pendingApproval: { id: string } };
  await decide(admin, moved.pendingApproval.id, 'APPROVE', 'Approved');
  await decide(priya, moved.pendingApproval.id, 'APPROVE', 'Received at Thrissur');
  // A transfer still waiting for the administrator, so the Transfer status column shows both.
  await assignAsset(it, monitor, { holder: { type: 'LOCATION', id: thrissur.id }, remarks: 'Extra screen for the Thrissur counter' });
  // The desktop stays in stock, so there is something to assign while trying the app.

  const counts = {
    organizations: await prisma.location.count({ where: { parentId: null } }),
    locations: await prisma.location.count({ where: { parentId: { not: null } } }),
    departments: await prisma.department.count(), categories: await prisma.assetCategory.count(),
    employees: await prisma.employee.count(), assets: await prisma.asset.count(),
    users: await prisma.user.count(), renewables: await prisma.renewable.count(),
  };
  console.log('Demo data loaded:', counts);
  return { adminEmail };
}

export function printSignIns(adminEmail: string) {
  console.log(`\nDEVELOPMENT ONLY — sign-ins (password: ${process.env.SEED_DEMO_PASSWORD ? '$SEED_DEMO_PASSWORD' : DEMO_PASSWORD}):`);
  console.log(`  Administrator  ${adminEmail}`);
  console.log(`  IT Operator    it@${DOMAIN}`);
  console.log(`  Branch user    br01@${DOMAIN} (Thrissur, Joy Alukkas; approves transfers into Thrissur)`);
}
