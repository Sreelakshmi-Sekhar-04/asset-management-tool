/**
 * DEVELOPMENT / UAT ONLY — keeps a handful of assets and permanently deletes all the others,
 * together with every transfer that contains a deleted asset.
 *
 *   npm run db:trim-assets -- --yes                        # keep the 5 most recently added assets
 *   npm run db:trim-assets -- --yes --keep 3               # keep the 3 most recently added
 *   npm run db:trim-assets -- --yes --codes AST-000001,AST-000007   # keep exactly these Asset IDs
 *
 * Deleted with each asset: its movement history, assignments, warranty/AMC/licence renewals,
 * reminders, verification lines, duplicate flags, device data, documents and integration
 * conflicts. Deleted with each transfer: its lines, receipts, exceptions, approval request and
 * documents. Notifications that link to a deleted asset or transfer are removed too.
 * A kept asset that sat in a deleted transfer stays where it is now and is free to move again;
 * its own history keeps those movements, without the link to the deleted transfer.
 *
 * Kept: users, employees, locations, master data, settings, the audit log (append-only by
 * design) and the Asset ID counters (so IDs are never reused). Uploaded files stay on disk.
 * Refuses to run without --yes, and when NODE_ENV=production unless ALLOW_DEMO_SEED=true.
 */
import { prisma } from '@/lib/db';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to delete assets in production. Set ALLOW_DEMO_SEED=true to override (staging/UAT only).');
  }
  const url = new URL(process.env.DATABASE_URL ?? '');
  const target = `${url.pathname.slice(1)} on ${url.hostname}:${url.port || 5432}`;

  const codes = arg('codes')?.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  const keepN = Number(arg('keep') ?? 5);
  if (!codes && (!Number.isInteger(keepN) || keepN < 0)) throw new Error('--keep must be a whole number.');
  const keep = codes
    ? await prisma.asset.findMany({ where: { assetCode: { in: codes } }, select: { id: true, assetCode: true } })
    : await prisma.asset.findMany({ orderBy: [{ createdAt: 'desc' }, { assetCode: 'desc' }], take: keepN, select: { id: true, assetCode: true } });
  if (codes) {
    const missing = codes.filter((c) => !keep.some((k) => k.assetCode === c));
    if (missing.length) throw new Error(`No asset with Asset ID ${missing.join(', ')}. Nothing was deleted.`);
  }
  const keepIds = keep.map((k) => k.id);
  const total = await prisma.asset.count();
  const dropAssets = (await prisma.asset.findMany({ where: { id: { notIn: keepIds } }, select: { id: true } })).map((a) => a.id);
  const dropTransfers = (await prisma.transfer.findMany({ where: { lines: { some: { assetId: { in: dropAssets } } } }, select: { id: true } })).map((t) => t.id);

  console.log(`Database ${target}: ${total} assets, ${await prisma.transfer.count()} transfers.`);
  console.log(`Keeping ${keep.length} asset(s): ${keep.map((k) => k.assetCode).sort().join(', ') || 'none'}`);
  console.log(`Deleting ${dropAssets.length} asset(s) and ${dropTransfers.length} transfer(s) that contain them.`);
  if (!process.argv.includes('--yes')) {
    throw new Error('Nothing was deleted. Re-run with --yes to confirm:\n  npm run db:trim-assets -- --yes');
  }
  if (!dropAssets.length) { console.log('Nothing to delete.'); return; }

  await prisma.$transaction(async (t) => {
    const run = (sql: string, ...params: unknown[]) => t.$executeRawUnsafe(sql, ...params);
    const A = dropAssets, T = dropTransfers;
    // Assets and their history refuse deletion by design; lift those guards for this transaction only.
    await run('ALTER TABLE "assets" DISABLE TRIGGER "assets_no_delete"');
    await run('ALTER TABLE "asset_movements" DISABLE TRIGGER "movements_no_delete"');
    await run('ALTER TABLE "asset_movements" DISABLE TRIGGER "movements_no_update"');

    // Transfers that contain a deleted asset, with everything hanging off them.
    const approvals = (await t.transfer.findMany({ where: { id: { in: T }, approvalRequestId: { not: null } }, select: { approvalRequestId: true } })).map((r) => r.approvalRequestId!);
    await run('DELETE FROM "transfer_exceptions" WHERE "transferId" = ANY($1) OR "assetId" = ANY($2)', T, A);
    await run('DELETE FROM "transfer_lines" WHERE "transferId" = ANY($1)', T);
    await run('DELETE FROM "transfer_receipts" WHERE "transferId" = ANY($1)', T);
    await run('DELETE FROM "documents" WHERE "entityType" = \'TRANSFER\' AND "entityId" = ANY($1)', T);
    await run('DELETE FROM "transfers" WHERE "id" = ANY($1)', T);
    await run('UPDATE "asset_movements" SET "transferId" = NULL, "transferLineId" = NULL WHERE "transferId" = ANY($1) AND NOT ("assetId" = ANY($2))', T, A);
    // Approval requests for those transfers or about deleted assets (their tasks cascade).
    await run('DELETE FROM "approval_requests" WHERE "id" = ANY($1) OR "entityId" = ANY($2) OR "entityId" = ANY($3) OR "assetIds" && $3::text[]', approvals, T, A);

    // The assets and everything that belongs to them.
    await run('DELETE FROM "renewal_reminders" WHERE "renewableId" IN (SELECT "id" FROM "renewables" WHERE "assetId" = ANY($1))', A);
    await run('DELETE FROM "renewal_events" WHERE "renewableId" IN (SELECT "id" FROM "renewables" WHERE "assetId" = ANY($1))', A);
    await run('DELETE FROM "documents" WHERE "entityType" = \'RENEWABLE\' AND "entityId" IN (SELECT "id" FROM "renewables" WHERE "assetId" = ANY($1))', A);
    await run(`DELETE FROM "notifications" WHERE substring("link" from '^/renewals/([^/?#]+)') IN (SELECT "id" FROM "renewables" WHERE "assetId" = ANY($1))`, A);
    await run('DELETE FROM "renewables" WHERE "assetId" = ANY($1)', A);
    await run('DELETE FROM "asset_movements" WHERE "assetId" = ANY($1)', A);
    await run('DELETE FROM "asset_assignments" WHERE "assetId" = ANY($1)', A);
    await run('DELETE FROM "verification_lines" WHERE "assetId" = ANY($1)', A);
    await run('DELETE FROM "duplicate_flags" WHERE "assetId" = ANY($1) OR "matchedAssetId" = ANY($1)', A);
    await run('DELETE FROM "asset_source_data" WHERE "assetId" = ANY($1)', A);
    await run('DELETE FROM "integration_conflicts" WHERE "entityId" = ANY($1)', A);
    await run('UPDATE "integration_unmatched" SET "assetId" = NULL WHERE "assetId" = ANY($1)', A);
    await run('UPDATE "verification_unlisted" SET "createdAssetId" = NULL WHERE "createdAssetId" = ANY($1)', A);
    await run('DELETE FROM "documents" WHERE "entityType" = \'ASSET\' AND "entityId" = ANY($1)', A);
    await run('DELETE FROM "assets" WHERE "id" = ANY($1)', A);

    // Notifications that would now open a missing page.
    await run(`DELETE FROM "notifications" WHERE substring("link" from '^/(?:assets|transfers)/([^/?#]+)') = ANY($1)`, [...A, ...T]);

    await run('ALTER TABLE "asset_movements" ENABLE TRIGGER "movements_no_update"');
    await run('ALTER TABLE "asset_movements" ENABLE TRIGGER "movements_no_delete"');
    await run('ALTER TABLE "assets" ENABLE TRIGGER "assets_no_delete"');
  }, { timeout: 600_000, maxWait: 30_000 });

  console.log(`Done: ${await prisma.asset.count()} assets and ${await prisma.transfer.count()} transfers remain.`);
}

main()
  .catch((e) => { console.error((e as Error).message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
