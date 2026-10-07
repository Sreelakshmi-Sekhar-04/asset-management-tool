/**
 * The small demo dataset shared by `npm run db:seed` (empty database) and
 * `npm run db:reset-demo` (wipes first). It is deliberately tiny, so the application reloads
 * quickly and every screen is readable:
 *
 *   1 organization, Joy Alukkas (the head quarter)  ·  5 locations (branches under it)
 *   5 departments  ·  5 categories  ·  5 assets  ·  5 warranty renewals
 *   5 people (employees), 3 of whom sign in: the Kochi MG Road branch manager (Administrator,
 *   first transfer approval), the Trivandrum branch manager (second approval for transfers into
 *   Trivandrum) and an IT operator who raises transfers
 *
 * Records are created through the application's own services, so each one carries its
 * movements and audit entries, and the demo history includes assignments and a transfer made
 * the way the asset register makes them. More organizations are added, when needed, under
 * Configuration → Organizations.
 */
import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/format';
import { SYSTEM_ACTOR, type Actor } from '@/server/actor';
import { actorForUser } from '@/server/services/approvals';
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

  // ── The organization (head quarter) and its five branches. Kochi MG Road is the demo's
  //    "current" branch; Trivandrum is where the transfer demo sends assets. ──
  const org = await createLocation(sys, { name: 'Joy Alukkas', type: 'ORGANIZATION', state: 'Kerala', parentId: null, code: 'JA-HQ' });
  const branch = (name: string, code: string) =>
    createLocation(sys, { name, type: 'BRANCH', state: 'Kerala', parentId: org.id, code, email: null });
  await branch('Thrissur', 'BR01');
  const kochi = await branch('Kochi MG Road', 'BR02');
  await branch('Kozhikode', 'BR03');
  const tvm = await branch('Trivandrum', 'BR04');
  await branch('Kannur', 'BR05');

  // ── 5 departments of the organization; 5 categories, shared master data ──
  const asOrg: Actor = { ...sys, orgId: org.id, orgIdPath: org.idPath, orgName: org.name };
  const depts: Record<string, string> = {};
  for (const d of ['Operations', 'Finance', 'IT', 'Sales', 'Human Resources']) depts[d] = (await createDepartment(asOrg, { name: d })).id;
  const cats: Record<string, string> = {};
  for (const [name, serialRequired] of [['Laptop', true], ['Desktop', true], ['Monitor', false], ['Printer', true], ['Mobile phone', true]] as const) {
    cats[name] = (await createCategory(sys, { name, serialRequired })).id;
  }

  // ── Exactly 5 people. Users and employees are one record per person: an employee, plus a
  //    sign-in for the three who use the application. The two branch managers approve transfers:
  //      Arun Mathew   Branch Manager, Kochi MG Road  Administrator  1st approval (admin manager)
  //      Lakshmi Varma Branch Manager, Trivandrum     Branch user    2nd approval (location manager)
  //      Deepak Nambiar IT executive, Kochi MG Road   IT Operator    raises the transfers
  //      Rohan Menon   Sales executive, Kochi         no sign-in     asset holder
  //      Ananya Pillai HR executive, Trivandrum       no sign-in     asset holder ──
  const emp = (code: string, name: string, dept: string, locationId: string, email: string, managerId?: string) =>
    createEmployee(asOrg, { employeeCode: code, name, email, departmentId: depts[dept], locationId, managerId });
  const mail = (name: string) => `${name.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`;
  const adminName = opts.adminName ?? 'Arun Mathew';
  const adminEmail = opts.adminEmail ?? mail(adminName);
  const eArun = await emp('JA1001', adminName, 'Operations', kochi.id, adminEmail);
  const eLakshmi = await emp('JA1002', 'Lakshmi Varma', 'Operations', tvm.id, mail('Lakshmi Varma'));
  const eDeepak = await emp('JA1003', 'Deepak Nambiar', 'IT', kochi.id, mail('Deepak Nambiar'), eArun.id);
  const eRohan = await emp('JA1004', 'Rohan Menon', 'Sales', kochi.id, mail('Rohan Menon'), eArun.id);
  const eAnanya = await emp('JA1005', 'Ananya Pillai', 'Human Resources', tvm.id, mail('Ananya Pillai'), eLakshmi.id);

  const mkUser = (email: string, name: string, role: 'ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER', employeeId: string, locationId: string | null = null) =>
    createUser(sys, { email, name, role, locationId, employeeId, password: DEMO_PASSWORD, sendInvite: false });
  const arun = await mkUser(adminEmail, adminName, 'ADMIN', eArun.id);
  const lakshmi = await mkUser(mail('Lakshmi Varma'), 'Lakshmi Varma', 'BRANCH_USER', eLakshmi.id, tvm.id);
  const deepak = await mkUser(mail('Deepak Nambiar'), 'Deepak Nambiar', 'IT_OPERATOR', eDeepak.id);
  const it = await actorForUser(prisma, deepak.id, org.id);

  // ── Location managers give the second transfer approval: Lakshmi for Trivandrum, Arun for
  //    Kochi MG Road and, through the organization, for every other branch ──
  await updateLocation(sys, tvm.id, { managerId: lakshmi.id });
  await updateLocation(sys, kochi.id, { managerId: arun.id });
  await updateLocation(sys, org.id, { managerId: arun.id });

  // ── 5 assets: four at Kochi MG Road, one at Trivandrum ──
  const mkAsset = async (cat: string, make: string, model: string, serial: string, locationId: string, cost: number, warrantyDays: number, hostname: string | null = null) => {
    const res = await createAsset(it, {
      categoryId: cats[cat], make, model, serialNumber: serial, hostname, locationId,
      purchaseDate: addDays(today, -400), purchaseCost: cost, vendor: 'Redington India',
      warrantyEnd: addDays(today, warrantyDays), condition: 'Good',
    }, { skipApproval: true });
    if (!('asset' in res) || !res.asset) throw new Error(`Could not create the ${cat} asset.`);
    return res.asset.id;
  };
  const laptop = await mkAsset('Laptop', 'Dell', 'Latitude 5440', 'DELAT100001', kochi.id, 78000, 300, 'BR02-LT-001');
  await mkAsset('Desktop', 'HP', 'ProDesk 400 G9', 'HPPRO100002', kochi.id, 55000, 25, 'BR02-DT-001');
  const printer = await mkAsset('Printer', 'HP', 'LaserJet Pro M404dn', 'HPLAS100004', kochi.id, 24000, -20, 'BR02-PR-001');
  await mkAsset('Monitor', 'Dell', 'P2422H', 'DEP24100003', kochi.id, 16500, 700);
  const phone = await mkAsset('Mobile phone', 'Samsung', 'Galaxy A54', 'SAGAL100005', tvm.id, 36000, 120);

  // ── History, made the way the asset register makes it. Nothing is approved here: ──
  await assignAsset(it, laptop, { holder: { type: 'EMPLOYEE', id: eRohan.id }, remarks: 'Demo data' });
  await assignAsset(it, phone, { holder: { type: 'EMPLOYEE', id: eAnanya.id }, remarks: 'Demo data' });
  // A transfer from Kochi MG Road to Trivandrum, waiting for Arun (1st) and then Lakshmi (2nd).
  await assignAsset(it, printer, { holder: { type: 'LOCATION', id: tvm.id }, remarks: 'Printer for the Trivandrum billing counter' });
  // The desktop and monitor stay in stock at Kochi MG Road, ready to assign or transfer.

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
  console.log(`  Administrator  ${adminEmail}  (Branch Manager, Kochi MG Road; 1st transfer approval)`);
  console.log(`  Branch user    lakshmi.varma@${DOMAIN}  (Branch Manager, Trivandrum; 2nd approval for transfers into Trivandrum)`);
  console.log(`  IT Operator    deepak.nambiar@${DOMAIN}  (IT, Kochi MG Road; raises transfers from the Asset Register)`);
  console.log('  Rohan Menon (Kochi MG Road) and Ananya Pillai (Trivandrum) are employees without a sign-in.');
}
