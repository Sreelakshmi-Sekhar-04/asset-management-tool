/**
 * The small demo dataset shared by `npm run db:seed` (empty database) and
 * `npm run db:reset-demo` (wipes first). It is deliberately tiny, so the application reloads
 * quickly and every screen is readable:
 *
 *   1 organization, Joy Alukkas (the head quarter), with only South India beneath it:
 *     South India (region) → Kerala, Tamil Nadu, Karnataka, Andhra Pradesh, Telangana (states)
 *     → 9 branches (Kochi MG Road, Trivandrum, Thrissur, Chennai T. Nagar, Coimbatore, Bengaluru
 *       Jayanagar, Vijayawada, Hyderabad Banjara Hills, Visakhapatnam)
 *   5 departments  ·  5 categories  ·  5 assets  ·  5 warranty renewals
 *   5 people (employees), 3 of whom sign in: Farah, the Kochi MG Road branch manager (Administrator,
 *   first transfer approval), Asha Monon, the Trivandrum branch manager (second approval and receipt
 *   for transfers into Trivandrum), and an IT operator who raises transfers. Farah and Asha Monon
 *   have real inboxes, so the approval emails can be tested end to end once SMTP is configured.
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

/** The two approvers have real inboxes, so the approval emails can be tested end to end. */
export const FARAH = { name: 'Farah', email: 'sreelakshmisekhar04@gmail.com' };
export const ASHA = { name: 'Asha Monon', email: 'sreelakshmi.sekhar@digitalfuturus.com' };

/** The demo covers South India only. */
export const SOUTH_STATES: [string, string][] = [['Kerala', 'KL'], ['Tamil Nadu', 'TN'], ['Karnataka', 'KA'], ['Andhra Pradesh', 'AP'], ['Telangana', 'TS']];
export const SOUTH_BRANCHES: [string, string, string][] = [
  ['Kerala', 'Kochi MG Road', 'BR02'], ['Kerala', 'Trivandrum', 'BR04'], ['Kerala', 'Thrissur', 'BR01'],
  ['Tamil Nadu', 'Chennai T. Nagar', 'BR06'], ['Tamil Nadu', 'Coimbatore', 'BR07'],
  ['Karnataka', 'Bengaluru Jayanagar', 'BR08'],
  ['Andhra Pradesh', 'Vijayawada', 'BR09'], ['Andhra Pradesh', 'Visakhapatnam', 'BR10'],
  ['Telangana', 'Hyderabad Banjara Hills', 'BR11'],
];

const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

export async function loadDemoData(opts: { actorName: string; adminEmail?: string; adminName?: string }) {
  const today = todayIST();
  const sys: Actor = { ...SYSTEM_ACTOR, name: opts.actorName };

  // ── The organization (head quarter), South India and its states and branches. Nothing outside
  //    the South region is created. Kochi MG Road is the demo's "current" branch; Trivandrum is
  //    where the transfer demo sends assets. ──
  const org = await createLocation(sys, { name: 'Joy Alukkas', type: 'ORGANIZATION', state: 'Kerala', parentId: null, code: 'JA-HQ' });
  const south = await createLocation(sys, { name: 'South India', type: 'REGION', state: null, parentId: org.id, code: 'SI' });
  const states: Record<string, string> = {};
  for (const [name, code] of SOUTH_STATES) states[name] = (await createLocation(sys, { name, type: 'STATE', state: name, parentId: south.id, code })).id;
  const branches: Record<string, { id: string }> = {};
  for (const [state, name, code] of SOUTH_BRANCHES) branches[name] = await createLocation(sys, { name, type: 'BRANCH', state, parentId: states[state], code, email: null });
  const kochi = branches['Kochi MG Road'];
  const tvm = branches['Trivandrum'];

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
  //      Farah          Branch Manager, Kochi MG Road  Administrator  1st approval (admin manager)
  //      Asha Monon     Branch Manager, Trivandrum     Branch user    2nd approval and receipt (location manager)
  //      Deepak Nambiar IT executive, Kochi MG Road    IT Operator    raises the transfers
  //      Rohan Menon    Sales executive, Kochi         no sign-in     asset holder
  //      Ananya Pillai  HR executive, Trivandrum       no sign-in     asset holder ──
  const emp = (code: string, name: string, dept: string, locationId: string, email: string, managerId?: string) =>
    createEmployee(asOrg, { employeeCode: code, name, email, departmentId: depts[dept], locationId, managerId });
  const mail = (name: string) => `${name.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`;
  const adminName = opts.adminName ?? FARAH.name;
  const adminEmail = opts.adminEmail ?? FARAH.email;
  const eFarah = await emp('JA1001', adminName, 'Operations', kochi.id, adminEmail);
  const eAsha = await emp('JA1002', ASHA.name, 'Operations', tvm.id, ASHA.email);
  const eDeepak = await emp('JA1003', 'Deepak Nambiar', 'IT', kochi.id, mail('Deepak Nambiar'), eFarah.id);
  const eRohan = await emp('JA1004', 'Rohan Menon', 'Sales', kochi.id, mail('Rohan Menon'), eFarah.id);
  const eAnanya = await emp('JA1005', 'Ananya Pillai', 'Human Resources', tvm.id, mail('Ananya Pillai'), eAsha.id);

  const mkUser = (email: string, name: string, role: 'ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER', employeeId: string, locationId: string | null = null) =>
    createUser(sys, { email, name, role, locationId, employeeId, password: DEMO_PASSWORD, sendInvite: false });
  const farah = await mkUser(adminEmail, adminName, 'ADMIN', eFarah.id);
  const asha = await mkUser(ASHA.email, ASHA.name, 'BRANCH_USER', eAsha.id, tvm.id);
  const deepak = await mkUser(mail('Deepak Nambiar'), 'Deepak Nambiar', 'IT_OPERATOR', eDeepak.id);
  const it = await actorForUser(prisma, deepak.id, org.id);

  // ── Location managers give the second transfer approval and confirm receipt: Asha Monon for
  //    Trivandrum, Farah for Kochi MG Road and, through the organization, for every other branch ──
  await updateLocation(sys, tvm.id, { managerId: asha.id });
  await updateLocation(sys, kochi.id, { managerId: farah.id });
  await updateLocation(sys, org.id, { managerId: farah.id });

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
  // A transfer from Kochi MG Road to Trivandrum, waiting for Farah (1st) and then Asha Monon (2nd).
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
  console.log(`  Administrator  ${adminEmail}  (Farah, Branch Manager, Kochi MG Road; 1st transfer approval)`);
  console.log(`  Branch user    ${ASHA.email}  (Asha Monon, Branch Manager, Trivandrum; 2nd approval and receipt for transfers into Trivandrum)`);
  console.log(`  IT Operator    deepak.nambiar@${DOMAIN}  (IT, Kochi MG Road; raises transfers from the Asset Register)`);
  console.log('  Rohan Menon (Kochi MG Road) and Ananya Pillai (Trivandrum) are employees without a sign-in.');
}
