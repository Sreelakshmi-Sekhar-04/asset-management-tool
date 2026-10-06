/**
 * DEVELOPMENT / UAT SEED DATA — NOT FOR PRODUCTION.
 *
 * Loads the small demo dataset: the Joy Alukkas organization and about 5 records of each kind
 * (3 users, 5 Kerala branches, 5 departments, 5 categories, 5 employees, 5 assets with their
 * warranty renewals, and a little assignment and transfer history). See scripts/demo-data.ts.
 * For a large organisation to test volume and load, use `npm run db:seed:large` instead.
 *
 * All demo accounts share one password, taken from SEED_DEMO_PASSWORD (default 'Demo#Pass2026').
 * The script refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true, and
 * skips a database that already has users.
 */
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/server/actor';
import { invalidateSettings } from '@/server/settings';
import { updateSettings } from '@/server/services/master';
import { loadDemoData, printSignIns } from '../scripts/demo-data';

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to load demo data in production. Set ALLOW_DEMO_SEED=true to override (staging/UAT only).');
  }
  if (await prisma.user.count()) {
    console.log('Database already has users; seed skipped. Run `npm run db:reset-demo -- --yes` to replace everything with the demo data.');
    return;
  }
  await updateSettings({ ...SYSTEM_ACTOR, name: 'Seed' }, { orgName: 'Joy Alukkas', transferAgingDays: 7 });
  invalidateSettings();
  printSignIns((await loadDemoData({ actorName: 'Seed' })).adminEmail);
}

main()
  .catch((e) => { console.error((e as Error).message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
