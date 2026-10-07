/**
 * Times the NFR-02 targets against a database loaded with `db:generate-volume`.
 * DEVELOPMENT / TEST ONLY: it creates transfers and an import in the target database.
 *
 *   DATABASE_URL=…/itam_volume npm run perf:check
 *
 * Service-layer timings (no HTTP or rendering), so they measure the query and
 * write paths the API uses. Prints PASS/FAIL per target and exits non-zero on a miss.
 */
import { prisma } from '@/lib/db';
import { actorForUser } from '@/server/services/approvals';
import { listAssets } from '@/server/services/assets';
import { dashboard } from '@/server/services/dashboard';
import { bulkAssign } from '@/server/services/lifecycle';
import { confirmImport, runCommit, runValidation, startImport } from '@/server/import/engine';

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run the performance check in production.');

const results: { name: string; ms: number; limit: number }[] = [];
async function time<T>(name: string, limitMs: number, fn: () => Promise<T>) {
  const t = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t);
  results.push({ name, ms, limit: limitMs });
  console.log(`${ms <= limitMs ? 'PASS' : 'FAIL'}  ${String(ms).padStart(6)} ms  (limit ${limitMs} ms)  ${name}`);
  return r;
}

async function main() {
  const total = await prisma.asset.count();
  console.log(`Assets in database: ${total}`);
  const itUser = await prisma.user.findFirstOrThrow({ where: { role: 'IT_OPERATOR', active: true } });
  const branchUser = await prisma.user.findFirstOrThrow({ where: { role: 'BRANCH_USER', active: true }, include: { location: true } });
  const it = await actorForUser(prisma, itUser.id);
  const br = await actorForUser(prisma, branchUser.id);
  const sample = await prisma.asset.findFirstOrThrow({ where: { ipAddress: { not: null }, hostname: { not: null } }, include: { location: true, category: true } });
  const page = { skip: 0, take: 50 };

  // TC-NFR-01: search by IP, hostname, branch, item.
  await time('Search by IP address', 1000, () => listAssets(it, { search: sample.ipAddress! }, page));
  await time('Search by hostname', 1000, () => listAssets(it, { search: sample.hostname! }, page));
  await time('Filter by branch', 1000, () => listAssets(it, { locationId: sample.locationId! }, page));
  await time('Filter by item (category)', 1000, () => listAssets(it, { categoryIds: [sample.categoryId] }, page));
  await time('Free-text search (make)', 1000, () => listAssets(it, { search: 'Latitude' }, page));
  await time('Branch user: own asset list', 1000, () => listAssets(br, {}, page));
  // TC-NFR-02: deep paging.
  await time('Asset list, first page', 1000, () => listAssets(it, {}, page));
  await time('Asset list, deep page (row 19,000)', 1000, () => listAssets(it, {}, { skip: Math.max(0, total - 1000), take: 50 }));
  await time('Dashboard (IT)', 2000, () => dashboard(it));
  await time('Dashboard (branch)', 2000, () => dashboard(br));

  // TC-NFR-03: transferring 100 assets in one action from the asset register.
  const free = (n: number, locId?: string) => prisma.asset.findMany({ where: { status: { in: ['IN_STOCK', 'ASSIGNED'] }, ...(locId ? { locationId: locId } : {}) }, select: { id: true, locationId: true }, take: n });
  const branchWithMost = (await prisma.asset.groupBy({ by: ['locationId'], where: { status: { not: 'RETIRED' } }, _count: true, orderBy: { _count: { locationId: 'desc' } }, take: 1 }))[0];
  const dest = await prisma.location.findFirstOrThrow({ where: { type: 'BRANCH', active: true, id: { not: branchWithMost.locationId! } } });
  const hundred = await free(100, branchWithMost.locationId!);
  await time('Transfer 100 assets in one action', 5000, () => bulkAssign(it, { assetIds: hundred.map((a) => a.id), holder: { type: 'LOCATION', id: dest.id }, remarks: 'Performance check' }));

  // The register assigns or transfers up to 2,000 assets in one action.
  const big = await free(2000, branchWithMost.locationId!);
  if (big.length >= 2000) {
    await time('Transfer 2,000 assets in one action', 60_000, () => bulkAssign(it, { assetIds: big.map((a) => a.id), holder: { type: 'LOCATION', id: dest.id }, remarks: 'Performance check (large)' }));
  } else console.log(`SKIP  2,000-asset transfer: only ${big.length} free assets in one branch (generate with --branch)`);

  // TC-IMP-14: 20,000-row import, dry run + commit.
  const cat = await prisma.assetCategory.findFirstOrThrow({ where: { active: true, serialRequired: false } }).catch(() => prisma.assetCategory.findFirstOrThrow({ where: { active: true } }));
  const run = Date.now().toString(36).toUpperCase();
  const rows = ['Category,Make,Model,Serial Number,Location'];
  for (let i = 0; i < 20_000; i++) rows.push(`${cat.name},Dell,Latitude 5440,PERF${run}-${i},${dest.namePath.replace(/ \/ /g, '/')}`);
  await time('Import 20,000 rows (dry run + commit)', 600_000, async () => {
    const job = await startImport(it, { type: 'ASSETS', mode: 'CREATE_ONLY', createMissing: false, fileName: 'perf.csv', data: Buffer.from(rows.join('\n')) });
    await runValidation(job.id);
    const v = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    if (v.status !== 'VALIDATED') throw new Error(`Dry run ended ${v.status}: ${v.error}`);
    await confirmImport(it, job.id);
    await runCommit(job.id);
    const c = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    if (c.status !== 'COMMITTED') throw new Error(`Commit ended ${c.status}: ${c.error}`);
  });

  const failed = results.filter((r) => r.ms > r.limit);
  console.log(failed.length ? `\n${failed.length} target(s) missed.` : '\nAll targets met.');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
