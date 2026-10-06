/**
 * LARGE DEVELOPMENT / UAT DATASET — NOT FOR PRODUCTION. `npm run db:seed:large`
 *
 * For volume and load testing (`db:generate-volume`, `load:test`); the everyday seed
 * (`npm run db:seed`) loads only about 5 records of each kind. Creates a realistic sample organisation through the application's own services, so
 * every record carries proper movements, audit entries and notifications:
 *   15 Kerala branches (South › Kerala) · 2 Administrators · 3 IT Operators · 15 branch users
 *   ~40 employees · ~150 assets · transfers in every state · an open exception
 *   renewables · approval and reminder policies · a verification campaign · a device source.
 *
 * All demo accounts share one password, taken from SEED_DEMO_PASSWORD (default below).
 * The script refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true, and
 * refuses to run on a database that already has users.
 */
import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/format';
import { SYSTEM_ACTOR, type Actor } from '@/server/actor';
import { invalidateSettings } from '@/server/settings';
import { actorForUser, decide, savePolicy } from '@/server/services/approvals';
import { createAsset } from '@/server/services/assets';
import { createEmployee } from '@/server/services/employees';
import { processBatch, saveSource } from '@/server/services/integrations';
import { assignAsset, retireAsset, startRepair } from '@/server/services/lifecycle';
import { createLocation } from '@/server/services/locations';
import { createCategory, createDepartment, updateSettings } from '@/server/services/master';
import { createRenewable, saveReminderPolicy } from '@/server/services/renewables';
import { createTransfer, receive } from '@/server/services/transfers';
import { createUser } from '@/server/services/users';
import { createCampaign, markLines, submitTask } from '@/server/services/verification';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Demo#Pass2026';
const DOMAIN = 'itam-demo.example.com';

// Deterministic PRNG so every seed produces the same dataset.
let seed = 20260930;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000));

// Kerala only: one region and one state, as in the everyday demo seed, with fifteen branches.
const REGIONS: Record<string, Record<string, string[]>> = {
  South: { Kerala: ['Kochi Kakkanad', 'Kochi MG Road', 'Thiruvananthapuram', 'Kollam', 'Pathanamthitta', 'Kozhikode', 'Malappuram', 'Kannur', 'Thrissur', 'Palakkad', 'Kochi Edappally', 'Alappuzha', 'Kottayam', 'Kasaragod', 'Kalpetta'] },
};

const CATALOGUE = [
  { cat: 'Laptop', items: [['Dell', 'Latitude 5440', 78000], ['HP', 'EliteBook 840 G10', 92000], ['Lenovo', 'ThinkPad T14 Gen 4', 88000]], host: 'LT' },
  { cat: 'Desktop', items: [['Dell', 'OptiPlex 7010', 62000], ['HP', 'ProDesk 400 G9', 55000]], host: 'DT' },
  { cat: 'Monitor', items: [['Dell', 'P2422H', 16500], ['LG', '24MP400', 11000]], host: null },
  { cat: 'Printer', items: [['HP', 'LaserJet Pro M404dn', 24000], ['Canon', 'imageCLASS MF445dw', 38000]], host: 'PR' },
  { cat: 'Network switch', items: [['Cisco', 'Catalyst 1000-24T', 68000]], host: 'SW' },
  { cat: 'Firewall', items: [['Fortinet', 'FortiGate 60F', 145000]], host: 'FW' },
  { cat: 'UPS', items: [['APC', 'Smart-UPS 1500VA', 52000]], host: null },
  { cat: 'Mobile phone', items: [['Samsung', 'Galaxy A54', 36000]], host: null },
] as const;

const FIRST = ['Aarav', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Kavya', 'Rahul', 'Meera', 'Karthik', 'Divya', 'Siddharth', 'Neha', 'Aditya', 'Pooja', 'Manish', 'Lakshmi', 'Nikhil', 'Shreya'];
const LAST = ['Sharma', 'Iyer', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Menon', 'Desai', 'Rao', 'Joshi', 'Kulkarni', 'Verma', 'Pillai', 'Shah', 'Singh'];

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to load demo data in production. Set ALLOW_DEMO_SEED=true to override (staging/UAT only).');
  }
  if (await prisma.user.count()) {
    console.log('Database already has users; seed skipped. Use an empty database for the large dataset.');
    return;
  }
  const today = todayIST();
  const sys: Actor = { ...SYSTEM_ACTOR, name: 'Seed' };

  // ── Organisation settings ──
  await updateSettings(sys, { orgName: 'Demo Organisation Pvt Ltd', transferAgingDays: 7 });
  invalidateSettings();

  // ── Users: administrators first (they own the rest of the seed) ──
  const mkUser = (email: string, name: string, role: 'ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER', locationId?: string) =>
    createUser(sys, { email, name, role, locationId: locationId ?? null, password: DEMO_PASSWORD, sendInvite: false });
  const admin = await mkUser(`admin@${DOMAIN}`, 'Asha Menon (Administrator)', 'ADMIN');
  await mkUser(`admin2@${DOMAIN}`, 'Ravi Kulkarni (Administrator)', 'ADMIN');
  const adminA = await actorForUser(prisma, admin.id);
  const itUsers = [];
  for (const [i, n] of ['Deepak Rao', 'Farah Shaikh', 'Gautam Iyer'].entries()) itUsers.push(await mkUser(`it${i + 1}@${DOMAIN}`, `${n} (IT)`, 'IT_OPERATOR'));
  const it = await actorForUser(prisma, itUsers[0].id);
  const it2 = await actorForUser(prisma, itUsers[1].id);

  // ── Locations ──
  const branches: { id: string; name: string; state: string; region: string; code: string }[] = [];
  const regionIds: Record<string, string> = {};
  let bn = 0;
  for (const [region, states] of Object.entries(REGIONS)) {
    const r = await createLocation(adminA, { name: region, type: 'REGION', parentId: null });
    regionIds[region] = r.id;
    for (const [state, names] of Object.entries(states)) {
      const s = await createLocation(adminA, { name: state, type: 'STATE', state, parentId: r.id });
      for (const name of names) {
        bn++;
        const code = `BR${String(bn).padStart(2, '0')}`;
        const b = await createLocation(adminA, { name, type: 'BRANCH', parentId: s.id, code, email: null });
        branches.push({ id: b.id, name, state, region, code });
      }
    }
  }
  const byName = (n: string) => branches.find((b) => b.name === n)!;
  const hq = byName('Kochi Edappally');

  // ── Master data ──
  const cats: Record<string, string> = {};
  for (const c of CATALOGUE) {
    const serialRequired = ['Laptop', 'Desktop', 'Printer', 'Network switch', 'Firewall', 'Mobile phone'].includes(c.cat);
    cats[c.cat] = (await createCategory(adminA, { name: c.cat, serialRequired })).id;
  }
  cats['Software licence'] = (await createCategory(adminA, { name: 'Software licence', serialRequired: false, individuallyTracked: false, isSoftware: true })).id;
  const depts: Record<string, string> = {};
  for (const d of ['Operations', 'Finance', 'Sales', 'Human Resources', 'IT', 'Customer Service']) depts[d] = (await createDepartment(adminA, { name: d })).id;

  // ── Employees: a branch manager plus 1–2 staff per branch (~40), managers linked ──
  const employees: { id: string; code: string; branchId: string; name: string }[] = [];
  let ec = 1001;
  const usedNames = new Set<string>();
  const personName = () => { let n; do { n = `${pick(FIRST)} ${pick(LAST)}`; } while (usedNames.has(n)); usedNames.add(n); return n; };
  for (const b of branches) {
    const mgrName = personName();
    const mgr = await createEmployee(adminA, { employeeCode: `EMP${ec++}`, name: mgrName, email: `${mgrName.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`, departmentId: depts.Operations, locationId: b.id });
    employees.push({ id: mgr.id, code: mgr.employeeCode, branchId: b.id, name: mgrName });
    const staff = b.id === hq.id ? 3 : int(1, 2);
    for (let i = 0; i < staff; i++) {
      const n = personName();
      const e = await createEmployee(adminA, { employeeCode: `EMP${ec++}`, name: n, email: `${n.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}`, departmentId: depts[pick(['Finance', 'Sales', 'Customer Service', 'Human Resources'])], locationId: b.id, managerId: mgr.id });
      employees.push({ id: e.id, code: e.employeeCode, branchId: b.id, name: n });
    }
  }
  const itEmp = await createEmployee(adminA, { employeeCode: `EMP${ec++}`, name: 'Deepak Rao', email: `it1@${DOMAIN}`, departmentId: depts.IT, locationId: hq.id });
  employees.push({ id: itEmp.id, code: itEmp.employeeCode, branchId: hq.id, name: 'Deepak Rao' });

  // ── Branch users: one per branch ──
  const branchUsers: Record<string, Actor> = {};
  for (const b of branches) {
    const u = await mkUser(`${b.code.toLowerCase()}@${DOMAIN}`, `${b.name} branch`, 'BRANCH_USER', b.id);
    branchUsers[b.id] = await actorForUser(prisma, u.id);
  }

  // ── Assets (~150), created by IT through the register service ──
  const assets: { id: string; code: string; branchId: string; cat: string; cost: number }[] = [];
  let serialN = 100000;
  for (const b of branches) {
    const n = b.id === hq.id ? 28 : int(8, 10);
    for (let i = 0; i < n; i++) {
      const c = i < 3 ? CATALOGUE[0] : i === 3 ? CATALOGUE[1] : i === 4 ? CATALOGUE[2] : pick([...CATALOGUE]);
      const [make, model, cost] = pick([...c.items]) as [string, string, number];
      const purchase = addDays(today, -int(120, 1500));
      const warrantyDays = int(-200, 900);
      const serial = `${make.slice(0, 2).toUpperCase()}${model.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase()}${serialN++}`;
      const res = await createAsset(it, {
        categoryId: cats[c.cat], make, model, serialNumber: serial,
        hostname: c.host ? `${b.code}-${c.host}-${String(i + 1).padStart(3, '0')}` : null,
        ipAddress: c.host ? `10.${branches.indexOf(b) + 10}.${int(1, 4)}.${int(10, 250)}` : null,
        legacyTag: rnd() < 0.3 ? `OLD-${b.code}-${int(1000, 9999)}` : null,
        purchaseDate: purchase, purchaseCost: cost, vendor: pick(['Redington India', 'Ingram Micro India', 'Rashi Peripherals', 'Supertron']),
        warrantyEnd: addDays(today, warrantyDays), condition: 'Good', locationId: b.id,
      }, { skipApproval: true });
      if ('asset' in res && res.asset) assets.push({ id: res.asset.id, code: res.asset.assetCode, branchId: b.id, cat: c.cat, cost });
    }
  }
  // A deliberate duplicate-suspect pair (same hostname, reason recorded).
  const dupSrc = assets.find((a) => a.cat === 'Laptop' && a.branchId === byName('Alappuzha').id)!;
  const dupHost = (await prisma.asset.findUniqueOrThrow({ where: { id: dupSrc.id } })).hostname;
  const dup = await createAsset(it, { categoryId: cats.Laptop, make: 'Dell', model: 'Latitude 5440', serialNumber: `DELAT${serialN++}`, hostname: dupHost, locationId: byName('Alappuzha').id, purchaseCost: 78000, warrantyEnd: addDays(today, 45), duplicateReason: 'Replacement laptop re-imaged with the old hostname; old unit awaiting return' }, { skipApproval: true });
  if ('asset' in dup && dup.asset) assets.push({ id: dup.asset.id, code: dup.asset.assetCode, branchId: byName('Alappuzha').id, cat: 'Laptop', cost: 78000 });

  // ── Assignments (≈60%), repairs and retirements ──
  for (const a of assets) {
    const r = rnd();
    const local = employees.filter((e) => e.branchId === a.branchId);
    if (['Laptop', 'Desktop', 'Mobile phone', 'Monitor'].includes(a.cat) && r < 0.75 && local.length) {
      await assignAsset(it, a.id, { holder: { type: 'EMPLOYEE', id: pick(local).id }, remarks: 'Issued at seed' });
    } else if (a.cat === 'Printer' && r < 0.6) {
      await assignAsset(it, a.id, { holder: { type: 'DEPARTMENT', id: depts.Operations }, remarks: 'Shared printer' });
    } else if (['Network switch', 'Firewall', 'UPS'].includes(a.cat) && r < 0.8) {
      await assignAsset(it, a.id, { holder: { type: 'LOCATION', id: a.branchId }, remarks: 'Installed in branch rack' });
    }
  }
  const inStock = async () => (await prisma.asset.findMany({ where: { status: 'IN_STOCK', id: { in: assets.map((a) => a.id) } }, select: { id: true, locationId: true } }));
  const stock1 = await inStock();
  for (const a of stock1.slice(0, 4)) await startRepair(it, a.id, { reason: pick(['Keyboard not responding', 'Display flicker', 'Battery swelling', 'Paper feed jam']) });
  for (const a of stock1.slice(4, 7)) await retireAsset(it, a.id, { reason: 'End of life; beyond economical repair', disposalType: pick(['SCRAPPED', 'SOLD', 'DONATED'] as const) });

  // ── Approval and reminder policies ──
  await savePolicy(adminA, null, { name: 'High-value transfers (₹1 lakh+)', action: 'TRANSFER', priority: 10, minCost: 100000, steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'IT_OPERATOR' }, { stepOrder: 2, approverType: 'ROLE', approverRole: 'ADMIN' }] });
  await savePolicy(adminA, null, { name: 'Inter-state transfers', action: 'TRANSFER', priority: 20, interState: true, steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'IT_OPERATOR' }] });
  await savePolicy(adminA, null, { name: 'Retirement sign-off', action: 'RETIRE', priority: 10, steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'ADMIN' }] });
  await savePolicy(adminA, null, { name: 'Assets above ₹2 lakh', action: 'ASSET_CREATE', priority: 10, minCost: 200000, steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'ADMIN' }] });
  await saveReminderPolicy(adminA, null, { name: 'Standard reminders', leadDays: [90, 30, 7, 1], notifyOwner: true, roles: ['IT_OPERATOR'], escalationDays: 7, escalationRole: 'ADMIN', priority: 100 });

  // ── Transfers in every state ──
  const stockAt = async (branchId: string, n: number, exclude: string[] = []) =>
    (await prisma.asset.findMany({ where: { locationId: branchId, status: { in: ['IN_STOCK', 'ASSIGNED'] }, id: { notIn: exclude }, transferLines: { none: { status: { in: ['PENDING_APPROVAL', 'IN_TRANSIT'] } } }, purchaseCost: { lt: 100000 } }, take: n, orderBy: { assetCode: 'asc' } })).map((a) => a.id);
  const used: string[] = [];
  const take = async (b: string, n: number) => { const ids = await stockAt(b, n, used); used.push(...ids); return ids; };

  // Completed (intra-state, IT-raised → auto-approved), received in full.
  const t1 = await createTransfer(it, { fromLocationId: byName('Thiruvananthapuram').id, toLocationId: byName('Kollam').id, reason: 'Branch expansion at Kollam', assetIds: await take(byName('Thiruvananthapuram').id, 3) });
  await receive(branchUsers[byName('Kollam').id], (t1 as { transfer: { id: string } }).transfer.id, { receivedByName: 'Store keeper, Kollam', all: 'RECEIVED' });
  // Completed with an exception (one line not received).
  const t2 = await createTransfer(it, { fromLocationId: byName('Alappuzha').id, toLocationId: byName('Kottayam').id, reason: 'Replacement stock for Kottayam', assetIds: await take(byName('Alappuzha').id, 3) });
  const t2id = (t2 as { transfer: { id: string } }).transfer.id;
  const t2lines = await prisma.transferLine.findMany({ where: { transferId: t2id }, orderBy: { assetCode: 'asc' } });
  await receive(branchUsers[byName('Kottayam').id], t2id, { receivedByName: 'Kottayam branch manager', lines: t2lines.map((l, i) => ({ lineId: l.id, outcome: i === 0 ? 'NOT_RECEIVED' : 'RECEIVED', reason: i === 0 ? 'Box missing on delivery' : null })) });
  // Partially received.
  const t3 = await createTransfer(it, { fromLocationId: byName('Kozhikode').id, toLocationId: byName('Malappuram').id, reason: 'Temporary deployment for audit season', assetIds: await take(byName('Kozhikode').id, 4) });
  const t3id = (t3 as { transfer: { id: string } }).transfer.id;
  const t3first = await prisma.transferLine.findFirstOrThrow({ where: { transferId: t3id }, orderBy: { assetCode: 'asc' } });
  await receive(branchUsers[byName('Malappuram').id], t3id, { receivedByName: 'Malappuram front office', lines: [{ lineId: t3first.id, outcome: 'RECEIVED' }] });
  // In transit (and aged beyond the threshold for the aging report).
  const t4 = await createTransfer(it, { fromLocationId: byName('Kochi Kakkanad').id, toLocationId: byName('Kochi MG Road').id, reason: 'Desk moves to Kochi MG Road', assetIds: await take(byName('Kochi Kakkanad').id, 2) });
  await prisma.transfer.update({ where: { id: (t4 as { transfer: { id: string } }).transfer.id }, data: { approvedAt: new Date(Date.now() - 10 * 86_400_000) } });
  await createTransfer(it, { fromLocationId: byName('Thrissur').id, toLocationId: byName('Palakkad').id, reason: 'New joiners at Palakkad', assetIds: await take(byName('Thrissur').id, 2) });
  // Pending approval: branch-raised (falls back to IT approval).
  await createTransfer(branchUsers[byName('Kasaragod').id], { fromLocationId: byName('Kasaragod').id, toLocationId: byName('Kalpetta').id, reason: 'Kalpetta printer failed; lending a spare', assetIds: await take(byName('Kasaragod').id, 1) });
  // Pending approval: inter-state (policy).
  await createTransfer(it, { fromLocationId: hq.id, toLocationId: byName('Kasaragod').id, reason: 'Stock replenishment for North Kerala', invoiceNumber: 'DC/2026/0412', assetIds: await take(hq.id, 3) });
  // Rejected: branch-raised, IT rejects.
  const t8 = await createTransfer(branchUsers[byName('Pathanamthitta').id], { fromLocationId: byName('Pathanamthitta').id, toLocationId: byName('Thiruvananthapuram').id, reason: 'Return surplus monitor', assetIds: await take(byName('Pathanamthitta').id, 1) });
  const t8req = await prisma.transfer.findUniqueOrThrow({ where: { id: (t8 as { transfer: { id: string } }).transfer.id } });
  if (t8req.approvalRequestId) await decide(it2, t8req.approvalRequestId, 'REJECT', 'Keep the monitor at Pathanamthitta; Thiruvananthapuram has spares.');
  // Draft.
  await createTransfer(it, { fromLocationId: byName('Kannur').id, toLocationId: byName('Kozhikode').id, reason: 'Consolidate spares at Kozhikode', assetIds: await take(byName('Kannur').id, 2), submit: false });
  // Cancelled.
  const { cancelTransfer } = await import('../src/server/services/transfers');
  const t10 = await createTransfer(it, { fromLocationId: byName('Kalpetta').id, toLocationId: byName('Kasaragod').id, reason: 'Raised in error', assetIds: await take(byName('Kalpetta').id, 1), submit: false });
  await cancelTransfer(it, (t10 as { transfer: { id: string } }).transfer.id);
  // Late-recorded (back-dated by IT).
  const t11 = await createTransfer(it, { fromLocationId: hq.id, toLocationId: byName('Alappuzha').id, reason: 'Physical move done last week; recording now', effectiveDate: addDays(today, -6), assetIds: await take(hq.id, 1) });
  await receive(branchUsers[byName('Alappuzha').id], (t11 as { transfer: { id: string } }).transfer.id, { receivedByName: 'Alappuzha IT desk', all: 'RECEIVED' });

  // ── Renewables beyond automatic warranties ──
  const fw = assets.filter((a) => a.cat === 'Firewall');
  for (const [i, a] of fw.entries()) {
    await createRenewable(it, { assetId: a.id, type: 'LICENCE', label: 'FortiGuard UTP bundle', vendor: 'Fortinet', identifier: `FG-UTP-${a.code}`, expiryDate: addDays(today, [12, 40, 75, 200][i % 4]), renewalTermMonths: 12, cost: 38000, ownerUserId: itUsers[0].id, critical: true });
  }
  for (const a of assets.filter((x) => x.cat === 'UPS').slice(0, 6)) {
    await createRenewable(it, { assetId: a.id, type: 'AMC', label: 'UPS annual maintenance contract', vendor: 'APC Service', expiryDate: addDays(today, int(-10, 120)), renewalTermMonths: 12, cost: 6500, ownerUserId: itUsers[1].id });
  }

  // ── Verification campaign: tasks for every branch; one submitted, one in progress ──
  const camp = await createCampaign(it, { name: `Quarterly physical verification ${today.slice(0, 7)}`, dueDate: addDays(today, 14), scope: 'ALL', recurrenceQuarterly: true });
  const doTask = async (branchName: string, submit: boolean) => {
    const task = await prisma.verificationTask.findFirstOrThrow({ where: { campaignId: camp.campaign.id, location: { name: branchName } } });
    const lines = await prisma.verificationLine.findMany({ where: { taskId: task.id, inTransit: false }, orderBy: { assetCode: 'asc' } });
    const ba = branchUsers[byName(branchName).id];
    const marks = lines.map((l, i) => i === 0 && submit ? { lineId: l.id, result: 'MISSING' as const, note: 'Not found at desk or store' }
      : i === 1 && submit ? { lineId: l.id, result: 'WRONG_DETAILS' as const, correctedHostname: `${byName(branchName).code}-LT-099`, note: 'Hostname label differs' }
      : { lineId: l.id, result: 'PRESENT' as const });
    await markLines(ba, task.id, { lines: submit ? marks : marks.slice(0, Math.ceil(marks.length / 2)) });
    if (submit) await submitTask(ba, task.id);
  };
  await doTask('Kalpetta', true);
  await doTask('Kannur', false);

  // ── A device integration source with one sample batch (health page, unmatched queue) ──
  const src = await saveSource(adminA, null, { key: 'mdm', name: 'Device management (sample)', kind: 'DEVICE', rateLimitPerMinute: 60, secondaryMatchKey: 'hostname', mappings: [{ field: 'hostname', rule: 'WARN' }, { field: 'ipAddress', rule: 'OVERWRITE' }, { field: 'macAddress', rule: 'OVERWRITE' }, { field: 'warrantyEnd', rule: 'WARN' }] });
  const sample = await prisma.asset.findMany({ where: { category: { name: 'Laptop' }, status: 'ASSIGNED' }, take: 5, orderBy: { assetCode: 'asc' } });
  const source = await prisma.integrationSource.findUniqueOrThrow({ where: { id: src.id } });
  await processBatch(source, {
    batchId: `seed-${today}`,
    records: [
      ...sample.map((a, i) => ({ externalId: `dev-${a.assetCode}`, serialNumber: a.serialNumber, ipAddress: a.ipAddress, macAddress: `00:1A:2B:3C:4D:${String(10 + i).padStart(2, '0')}`, os: 'Windows 11 Pro', osVersion: '23H2', lastSeen: new Date().toISOString(), patchStatus: i % 2 ? 'Up to date' : '2 updates pending', lastPatched: addDays(today, -int(1, 30)), applications: ['Microsoft 365 Apps', 'Google Chrome', 'Zoom'] })),
      { externalId: 'dev-unknown-1', serialNumber: 'UNKNOWN-SN-0001', hostname: 'UNREG-LT-001', os: 'Windows 11 Pro', lastSeen: new Date().toISOString() },
    ],
  });

  const counts = { users: await prisma.user.count(), locations: await prisma.location.count(), employees: await prisma.employee.count(), assets: await prisma.asset.count(), transfers: await prisma.transfer.count(), renewables: await prisma.renewable.count(), notifications: await prisma.notification.count() };
  console.log('Seed complete:', counts);
  console.log(`\nDEVELOPMENT ONLY — demo sign-ins (password: ${process.env.SEED_DEMO_PASSWORD ? '$SEED_DEMO_PASSWORD' : DEMO_PASSWORD}):`);
  console.log(`  Administrator  admin@${DOMAIN}`);
  console.log(`  IT Operator    it1@${DOMAIN}`);
  console.log(`  Branch user    br01@${DOMAIN}  (Kochi Kakkanad) … br15@${DOMAIN}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
