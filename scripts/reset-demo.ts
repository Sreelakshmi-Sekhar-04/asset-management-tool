/**
 * DEVELOPMENT / UAT ONLY — wipes every record and loads a small demo dataset.
 *
 *   npm run db:reset-demo -- --yes
 *   npm run db:reset-demo -- --yes --admin-email you@company.com --admin-name "Your Name"
 *
 * Deletes ALL data (users, assets, employees, locations, transfers, audit log, history …)
 * from the database in DATABASE_URL, then creates 5 of each through the application's own
 * services: 5 people (3 sign-ins) · 5 Kerala branches · 5 departments · 5 categories · 5 assets
 * (each with a warranty, so 5 renewables), all in the Joy Alukkas organization, plus a little
 * assignment and transfer history.
 * Side records the services write for those (movements, audit entries, notifications) remain.
 *
 * Kept: the schema and migration history, saved settings (organisation name, Asset ID format)
 * and the Asset ID counters, so new IDs continue after the old ones and a printed label can
 * never point at a different asset. Uploaded files under STORAGE_DIR are not touched.
 *
 * All three sign-ins share one password: SEED_DEMO_PASSWORD, or the development default below.
 * Refuses to run without --yes, and when NODE_ENV=production unless ALLOW_DEMO_SEED=true.
 */
import { prisma } from '@/lib/db';
import { invalidateSettings } from '@/server/settings';
import { loadDemoData, printSignIns } from './demo-data';

/** Never emptied: migration history, configuration, and the Asset ID counters (IDs are never reused). */
const KEEP = new Set(['_prisma_migrations', 'Setting', 'asset_code_counters']);

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function wipe() {
  const tables = (await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`)
    .map((r) => r.tablename).filter((t) => !KEEP.has(t));
  const list = tables.map((t) => `"${t}"`).join(', ');
  await prisma.$transaction([
    // The audit log refuses TRUNCATE by design; lift that guard for this transaction only.
    prisma.$executeRawUnsafe('ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_no_truncate"'),
    prisma.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`),
    prisma.$executeRawUnsafe('ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_no_truncate"'),
  ]);
  return tables.length;
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to reset a production database. Set ALLOW_DEMO_SEED=true to override (staging/UAT only).');
  }
  const url = new URL(process.env.DATABASE_URL ?? '');
  const target = `${url.pathname.slice(1)} on ${url.hostname}:${url.port || 5432}`;
  if (!process.argv.includes('--yes')) {
    throw new Error(`This deletes ALL data in database ${target}. Re-run with --yes to confirm:\n  npm run db:reset-demo -- --yes`);
  }

  console.log(`Wiping database ${target} …`);
  console.log(`Emptied ${await wipe()} tables.`);
  invalidateSettings();

  const { adminEmail } = await loadDemoData({ actorName: 'Demo reset', adminEmail: arg('admin-email'), adminName: arg('admin-name') });
  printSignIns(adminEmail);
}

main()
  .catch((e) => { console.error((e as Error).message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
