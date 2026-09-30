/**
 * Volume data for performance testing (NFR-01/02: 20,000 assets, lists and reports
 * under the response-time targets). DEVELOPMENT / TEST ONLY.
 *
 *   npm run db:generate-volume -- --assets 20000
 *
 * Adds assets spread across every active branch, ~60% assigned to generated employees,
 * with REGISTERED/ASSIGNED movement history, assignment rows and warranty renewables,
 * so the register, dashboards, reports and verification snapshots run against a
 * realistic data set. Needs the demo seed (or real locations/categories) first.
 * Refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const arg = (name: string, def: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
const pick = <T>(a: T[], i: number) => a[i % a.length];
const MODELS: Record<string, [string, string][]> = {
  Laptop: [['Dell', 'Latitude 5440'], ['Lenovo', 'ThinkPad E14'], ['HP', 'ProBook 440 G10']],
  Desktop: [['Dell', 'OptiPlex 7010'], ['HP', 'ProDesk 400 G9'], ['Lenovo', 'ThinkCentre M70s']],
  Printer: [['HP', 'LaserJet Pro M404'], ['Canon', 'imageCLASS MF264']],
  Firewall: [['Fortinet', 'FortiGate 60F']],
};

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Refusing to generate volume data in production.');
  const total = arg('assets', 20_000);
  const batch = 1000;
  const branches = await prisma.location.findMany({ where: { active: true, type: 'BRANCH' }, select: { id: true, namePath: true } });
  const cats = await prisma.assetCategory.findMany({ where: { active: true, individuallyTracked: true } });
  const depts = await prisma.department.findMany({ where: { active: true } });
  if (!branches.length || !cats.length) throw new Error('No active branches or categories: run the seed (npm run db:seed) or create master data first.');
  const run = Date.now().toString(36).toUpperCase();
  console.log(`Generating ${total} assets across ${branches.length} branches (run ${run})…`);

  // One employee per ~6 assets, spread over branches.
  const empCount = Math.ceil(total / 6);
  const emps: { id: string; name: string; employeeCode: string; locationId: string | null }[] = [];
  for (let i = 0; i < empCount; i += batch) {
    const rows = Array.from({ length: Math.min(batch, empCount - i) }, (_, k) => {
      const n = i + k;
      return { employeeCode: `V${run}-${String(n).padStart(6, '0')}`, name: `Volume Employee ${n}`, email: `vol${n}.${run.toLowerCase()}@itam-demo.example.com`, locationId: pick(branches, n).id, departmentId: depts.length ? pick(depts, n).id : null, fieldSources: {} };
    });
    emps.push(...(await prisma.employee.createManyAndReturn({ data: rows, select: { id: true, name: true, employeeCode: true, locationId: true } })));
  }

  const started = Date.now();
  const today = new Date();
  for (let i = 0; i < total; i += batch) {
    const size = Math.min(batch, total - i);
    const data: Prisma.AssetCreateManyInput[] = [];
    for (let k = 0; k < size; k++) {
      const n = i + k;
      const cat = pick(cats, n);
      const [make, model] = pick(MODELS[cat.name] ?? [['Generic', `${cat.name} Model`]], n);
      const branch = pick(branches, n * 7);
      const assign = n % 10 < 6 && !cat.isSoftware;
      const emp = assign ? emps[n % emps.length] : null;
      const purchase = new Date(today.getTime() - ((n * 37) % 1400) * 86_400_000);
      const warranty = new Date(purchase.getTime() + 3 * 365 * 86_400_000);
      data.push({
        categoryId: cat.id, make, model, serialNumber: `VOL${run}${String(n).padStart(7, '0')}`, hostname: `VOL-${run}-${n}`, ipAddress: `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`,
        purchaseDate: new Date(purchase.toISOString().slice(0, 10)), purchaseCost: 20_000 + ((n * 131) % 180_000), vendor: 'Volume Test Supplies', warrantyEnd: new Date(warranty.toISOString().slice(0, 10)),
        status: assign ? 'ASSIGNED' : 'IN_STOCK', locationId: branch.id, holderType: emp ? 'EMPLOYEE' : null, holderEmployeeId: emp?.id ?? null, origin: 'volume-test', fieldSources: {},
      });
    }
    const created = await prisma.asset.createManyAndReturn({ data });
    const byLoc = new Map(branches.map((b) => [b.id, b.namePath]));
    const empById = new Map(emps.map((e) => [e.id, e]));
    await prisma.assetMovement.createMany({ data: created.map((a) => ({ assetId: a.id, kind: 'REGISTERED' as const, toLocationId: a.locationId, toLocationName: byLoc.get(a.locationId!) ?? null, toStatus: 'IN_STOCK' as const, effectiveAt: a.createdAt, actorName: 'Volume generator', reason: 'Volume test data' })) });
    const assigned = created.filter((a) => a.holderEmployeeId);
    await prisma.assetMovement.createMany({ data: assigned.map((a) => ({ assetId: a.id, kind: 'ASSIGNED' as const, fromLocationId: a.locationId, toLocationId: a.locationId, toHolderType: 'EMPLOYEE' as const, toHolderId: a.holderEmployeeId, toHolderName: empById.get(a.holderEmployeeId!)?.name ?? null, fromStatus: 'IN_STOCK' as const, toStatus: 'ASSIGNED' as const, effectiveAt: a.createdAt, actorName: 'Volume generator' })) });
    await prisma.assetAssignment.createMany({ data: assigned.map((a) => ({ assetId: a.id, holderType: 'EMPLOYEE' as const, holderId: a.holderEmployeeId!, holderName: empById.get(a.holderEmployeeId!)?.name ?? '', startAt: a.createdAt, source: 'IMPORT' })) });
    await prisma.renewable.createMany({ data: created.filter((a) => a.warrantyEnd).map((a) => ({ assetId: a.id, type: 'WARRANTY' as const, label: `Warranty — ${a.make} ${a.model}`, vendor: a.vendor, startDate: a.purchaseDate, expiryDate: a.warrantyEnd!, source: 'asset-warranty', sourceKey: 'asset-warranty', status: a.warrantyEnd! < today ? 'EXPIRED' as const : 'ACTIVE' as const })) });
    process.stdout.write(`\r  ${i + size}/${total} assets`);
  }
  await prisma.auditLog.create({ data: { action: 'VOLUME_DATA_GENERATED', entityType: 'System', entityLabel: `${total} assets`, details: { run, assets: total, employees: empCount } } });
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s. ${total} assets and ${empCount} employees added (serials VOL${run}…).`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
