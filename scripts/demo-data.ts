/**
 * The small demo dataset shared by `npm run db:seed` (empty database) and
 * `npm run db:reset-demo` (wipes first): at most 5 records of each kind, created through
 * the application's own services so each carries its movements and audit entries.
 *   5 users · 5 locations · 5 departments · 5 categories · 5 employees
 *   5 assets (each with a warranty, so 5 renewables) · 5 transfers, one in each state.
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
import { createTransfer, receive } from '@/server/services/transfers';
import { createUser } from '@/server/services/users';

export const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Demo#Pass2026';
export const DOMAIN = 'itam-demo.example.com';

const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const transferId = (r: unknown) => (r as { transfer: { id: string } }).transfer.id;

export async function loadDemoData(opts: { actorName: string; adminEmail?: string; adminName?: string }) {
  const today = todayIST();
  const sys: Actor = { ...SYSTEM_ACTOR, name: opts.actorName };

  // ── 5 locations: South › Kerala › three branches ──
  const region = await createLocation(sys, { name: 'South', type: 'REGION', parentId: null });
  const state = await createLocation(sys, { name: 'Kerala', type: 'STATE', state: 'Kerala', parentId: region.id });
  const branch = (name: string, code: string) => createLocation(sys, { name, type: 'BRANCH', state: 'Kerala', parentId: state.id, code, email: null });
  const b1 = await branch('Kochi', 'BR01');
  const b2 = await branch('Thiruvananthapuram', 'BR02');
  const b3 = await branch('Kozhikode', 'BR03');

  // ── 5 users: 1 Administrator, 2 IT Operators, 2 branch users ──
  const mkUser = (email: string, name: string, role: 'ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER', locationId: string | null = null) =>
    createUser(sys, { email, name, role, locationId, password: DEMO_PASSWORD, sendInvite: false });
  const adminEmail = opts.adminEmail ?? `admin@${DOMAIN}`;
  const admin = await mkUser(adminEmail, opts.adminName ?? 'Asha Menon (Administrator)', 'ADMIN');
  const it1 = await mkUser(`it1@${DOMAIN}`, 'Deepak Rao (IT)', 'IT_OPERATOR');
  await mkUser(`it2@${DOMAIN}`, 'Farah Shaikh (IT)', 'IT_OPERATOR');
  const br1 = await mkUser(`br01@${DOMAIN}`, 'Kochi branch', 'BRANCH_USER', b1.id);
  const br2 = await mkUser(`br02@${DOMAIN}`, 'Thiruvananthapuram branch', 'BRANCH_USER', b2.id);
  const adminA = await actorForUser(prisma, admin.id);
  const it = await actorForUser(prisma, it1.id);
  const branchKochi = await actorForUser(prisma, br1.id);
  const branchTvm = await actorForUser(prisma, br2.id);

  // ── 5 departments and 5 categories ──
  const depts: Record<string, string> = {};
  for (const d of ['Operations', 'Finance', 'Sales', 'Human Resources', 'IT']) depts[d] = (await createDepartment(adminA, { name: d })).id;
  const cats: Record<string, string> = {};
  for (const [name, serialRequired] of [['Laptop', true], ['Desktop', true], ['Monitor', false], ['Printer', true], ['Mobile phone', true]] as const) {
    cats[name] = (await createCategory(adminA, { name, serialRequired })).id;
  }

  // ── 5 employees ──
  const emp = (code: string, name: string, dept: string, locationId: string) =>
    createEmployee(adminA, { employeeCode: code, name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`, departmentId: depts[dept], locationId });
  const e1 = await emp('EMP1001', 'Priya Nair', 'Operations', b1.id);
  const e2 = await emp('EMP1002', 'Rohan Menon', 'Finance', b1.id);
  await emp('EMP1003', 'Ananya Pillai', 'Sales', b2.id);
  await emp('EMP1004', 'Karthik Iyer', 'Human Resources', b3.id);
  await emp('EMP1005', 'Meera Varma', 'IT', b2.id);

  // ── 5 assets, each with a warranty (which creates its warranty renewal) ──
  const mkAsset = async (cat: string, make: string, model: string, serial: string, locationId: string, cost: number, warrantyDays: number, hostname: string | null = null) => {
    const res = await createAsset(it, {
      categoryId: cats[cat], make, model, serialNumber: serial, hostname, locationId,
      purchaseDate: addDays(today, -400), purchaseCost: cost, vendor: 'Redington India',
      warrantyEnd: addDays(today, warrantyDays), condition: 'Good',
    }, { skipApproval: true });
    if (!('asset' in res) || !res.asset) throw new Error(`Could not create the ${cat} asset.`);
    return res.asset.id;
  };
  const a1 = await mkAsset('Laptop', 'Dell', 'Latitude 5440', 'DELAT100001', b1.id, 78000, 300, 'BR01-LT-001');
  const a2 = await mkAsset('Desktop', 'HP', 'ProDesk 400 G9', 'HPPRO100002', b1.id, 55000, 25);
  const a3 = await mkAsset('Monitor', 'Dell', 'P2422H', 'DEP24100003', b2.id, 16500, 700);
  const a4 = await mkAsset('Printer', 'HP', 'LaserJet Pro M404dn', 'HPLAS100004', b1.id, 24000, -20, 'BR01-PR-001');
  const a5 = await mkAsset('Mobile phone', 'Samsung', 'Galaxy A54', 'SAGAL100005', b3.id, 36000, 120);
  await assignAsset(it, a1, { holder: { type: 'EMPLOYEE', id: e1.id }, remarks: 'Demo data' });
  await assignAsset(it, a2, { holder: { type: 'EMPLOYEE', id: e2.id }, remarks: 'Demo data' });

  // ── 5 transfers, one in each state ──
  // Completed: received in full at Thiruvananthapuram.
  const t1 = await createTransfer(it, { fromLocationId: b1.id, toLocationId: b2.id, reason: 'Desk move to Thiruvananthapuram', assetIds: [a2] });
  await receive(branchTvm, transferId(t1), { receivedByName: 'Thiruvananthapuram front office', all: 'RECEIVED' });
  // Completed with an exception: the asset did not arrive.
  const t2 = await createTransfer(it, { fromLocationId: b2.id, toLocationId: b3.id, reason: 'Spare monitor for Kozhikode', assetIds: [a3] });
  const t2line = await prisma.transferLine.findFirstOrThrow({ where: { transferId: transferId(t2) } });
  await receive(it, transferId(t2), { receivedByName: 'Kozhikode store keeper', lines: [{ lineId: t2line.id, outcome: 'NOT_RECEIVED', reason: 'Box missing on delivery' }] });
  // In transit.
  await createTransfer(it, { fromLocationId: b3.id, toLocationId: b1.id, reason: 'Phone for a new joiner at Kochi', assetIds: [a5] });
  // Pending approval: raised by a branch user, waiting for IT.
  await createTransfer(branchKochi, { fromLocationId: b1.id, toLocationId: b2.id, reason: 'Lend the spare printer to Thiruvananthapuram', assetIds: [a4] });
  // Draft.
  await createTransfer(it, { fromLocationId: b1.id, toLocationId: b3.id, reason: 'Laptop swap with Kozhikode (not yet submitted)', assetIds: [a1], submit: false });

  const counts = {
    users: await prisma.user.count(), locations: await prisma.location.count(), departments: await prisma.department.count(),
    categories: await prisma.assetCategory.count(), employees: await prisma.employee.count(), assets: await prisma.asset.count(),
    transfers: await prisma.transfer.count(), renewables: await prisma.renewable.count(),
  };
  console.log('Demo data loaded:', counts);
  return { adminEmail };
}

export function printSignIns(adminEmail: string) {
  console.log(`\nDEVELOPMENT ONLY — sign-ins (password: ${process.env.SEED_DEMO_PASSWORD ? '$SEED_DEMO_PASSWORD' : DEMO_PASSWORD}):`);
  console.log(`  Administrator  ${adminEmail}`);
  console.log(`  IT Operators   it1@${DOMAIN}, it2@${DOMAIN}`);
  console.log(`  Branch users   br01@${DOMAIN} (Kochi), br02@${DOMAIN} (Thiruvananthapuram)`);
}
