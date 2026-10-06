/**
 * The small demo dataset shared by `npm run db:seed` (empty database) and
 * `npm run db:reset-demo` (wipes first). It is deliberately tiny, so the application reloads
 * quickly and every screen is readable:
 *
 *   2 organizations (head quarters)  ·  5 locations (branches under them)  ·  5 departments
 *   5 categories  ·  5 employees  ·  5 assets  ·  3 users  ·  5 warranty renewals
 *
 * Nothing is duplicated per organization: the five locations, departments, employees and assets
 * are split between the two, so switching the organization visibly changes every list while the
 * totals stay at five. Records are created through the application's own services, so each one
 * carries its movements and audit entries, and the demo history includes assignments and a
 * transfer made the way the asset register makes them.
 */
import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/format';
import { SYSTEM_ACTOR, type Actor } from '@/server/actor';
import { actorForUser } from '@/server/services/approvals';
import { createAsset } from '@/server/services/assets';
import { createEmployee } from '@/server/services/employees';
import { assignAsset } from '@/server/services/lifecycle';
import { createLocation } from '@/server/services/locations';
import { createCategory, createDepartment } from '@/server/services/master';
import { createUser } from '@/server/services/users';

export const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Demo#Pass2026';
export const DOMAIN = 'itam-demo.example.com';

const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

export async function loadDemoData(opts: { actorName: string; adminEmail?: string; adminName?: string }) {
  const today = todayIST();
  const sys: Actor = { ...SYSTEM_ACTOR, name: opts.actorName };

  // ── Two organizations (head quarters), each with its own branches ──
  const orgA = await createLocation(sys, { name: 'Tropicana Kochi', type: 'ORGANIZATION', state: 'Kerala', parentId: null, code: 'ORG-A' });
  const orgB = await createLocation(sys, { name: 'Tropicana Kozhikode', type: 'ORGANIZATION', state: 'Kerala', parentId: null, code: 'ORG-B' });
  const branch = (name: string, code: string, parentId: string) =>
    createLocation(sys, { name, type: 'BRANCH', state: 'Kerala', parentId, code, email: null });
  // 3 branches in organization A, 2 in organization B — five locations in all.
  const a1 = await branch('Kakkanad', 'BR01', orgA.id);
  const a2 = await branch('MG Road', 'BR02', orgA.id);
  const a3 = await branch('Aluva', 'BR03', orgA.id);
  const b1 = await branch('Kozhikode Town', 'BR04', orgB.id);
  const b2 = await branch('Vadakara', 'BR05', orgB.id);

  // ── 5 departments, each belonging to one organization; 5 categories, shared master data ──
  const asOrg = (orgId: string): Actor => ({ ...sys, orgId, orgIdPath: `/${orgId}/` });
  const depts: Record<string, string> = {};
  for (const d of ['Operations', 'Finance', 'IT']) depts[d] = (await createDepartment(asOrg(orgA.id), { name: d })).id;
  for (const d of ['Sales', 'Human Resources']) depts[d] = (await createDepartment(asOrg(orgB.id), { name: d })).id;
  const cats: Record<string, string> = {};
  for (const [name, serialRequired] of [['Laptop', true], ['Desktop', true], ['Monitor', false], ['Printer', true], ['Mobile phone', true]] as const) {
    cats[name] = (await createCategory(sys, { name, serialRequired })).id;
  }

  // ── 5 employees: 3 in organization A, 2 in organization B ──
  const emp = (code: string, name: string, dept: string, locationId: string, email?: string) =>
    createEmployee(sys, { employeeCode: code, name, email: email ?? `${name.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`, departmentId: depts[dept], locationId });
  const adminEmail = opts.adminEmail ?? `admin@${DOMAIN}`;
  const adminName = opts.adminName ?? 'Asha Menon';
  const eAdmin = await emp('EMP1001', adminName, 'IT', a1.id, adminEmail);
  const eIt = await emp('EMP1002', 'Deepak Nambiar', 'IT', a2.id, `it@${DOMAIN}`);
  const e1 = await emp('EMP1003', 'Priya Nair', 'Operations', a1.id, `br01@${DOMAIN}`);
  const e2 = await emp('EMP1004', 'Rohan Menon', 'Sales', b1.id);
  await emp('EMP1005', 'Ananya Pillai', 'Human Resources', b2.id);

  // ── 3 users, one per role, each linked to their employee record ──
  const mkUser = (email: string, name: string, role: 'ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER', employeeId: string, locationId: string | null = null) =>
    createUser(sys, { email, name, role, locationId, employeeId, password: DEMO_PASSWORD, sendInvite: false });
  await mkUser(adminEmail, adminName, 'ADMIN', eAdmin.id);
  const it1 = await mkUser(`it@${DOMAIN}`, 'Deepak Nambiar', 'IT_OPERATOR', eIt.id);
  await mkUser(`br01@${DOMAIN}`, 'Priya Nair', 'BRANCH_USER', e1.id, a1.id);
  const it = await actorForUser(prisma, it1.id, orgA.id);
  const itB = await actorForUser(prisma, it1.id, orgB.id);

  // ── 5 assets: 3 in organization A, 2 in organization B ──
  const mkAsset = async (actor: Actor, cat: string, make: string, model: string, serial: string, locationId: string, cost: number, warrantyDays: number, hostname: string | null = null) => {
    const res = await createAsset(actor, {
      categoryId: cats[cat], make, model, serialNumber: serial, hostname, locationId,
      purchaseDate: addDays(today, -400), purchaseCost: cost, vendor: 'Redington India',
      warrantyEnd: addDays(today, warrantyDays), condition: 'Good',
    }, { skipApproval: true });
    if (!('asset' in res) || !res.asset) throw new Error(`Could not create the ${cat} asset.`);
    return res.asset.id;
  };
  const a1Laptop = await mkAsset(it, 'Laptop', 'Dell', 'Latitude 5440', 'DELAT100001', a1.id, 78000, 300, 'BR01-LT-001');
  const a1Desktop = await mkAsset(it, 'Desktop', 'HP', 'ProDesk 400 G9', 'HPPRO100002', a1.id, 55000, 25);
  const a1Printer = await mkAsset(it, 'Printer', 'HP', 'LaserJet Pro M404dn', 'HPLAS100004', a2.id, 24000, -20, 'BR01-PR-001');
  const b1Monitor = await mkAsset(itB, 'Monitor', 'Dell', 'P2422H', 'DEP24100003', b1.id, 16500, 700);
  const b1Phone = await mkAsset(itB, 'Mobile phone', 'Samsung', 'Galaxy A54', 'SAGAL100005', b2.id, 36000, 120);

  // ── History, made the way the asset register makes it ──
  // Assigned to an employee.
  await assignAsset(it, a1Laptop, { holder: { type: 'EMPLOYEE', id: e1.id }, remarks: 'Demo data' });
  await assignAsset(itB, b1Phone, { holder: { type: 'EMPLOYEE', id: e2.id }, remarks: 'Demo data' });
  // Assigned to a location, which is a transfer: the printer moves to another branch.
  await assignAsset(it, a1Printer, { holder: { type: 'LOCATION', id: a3.id }, remarks: 'Moved to Aluva' });
  void a1Desktop; void b1Monitor; // left in stock, so there is something to assign while trying the app

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
  console.log(`  Branch user    br01@${DOMAIN} (Kakkanad, Tropicana Kochi)`);
}
