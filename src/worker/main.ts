/**
 * Background worker: import jobs, the email outbox, daily schedules (renewal
 * reminders, verification recurrence and reminders, transfer aging, document purge,
 * housekeeping) and integration pull / directory sync schedules.
 * Run alongside the web app: `npm run worker`.
 */
import { prisma } from '@/lib/db';
import { sendPendingEmails } from './email';
import { drainJobs, runDailyTasks, runIntegrationSchedules } from './tasks';

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 5_000);
const SCHEDULE_EVERY_MS = 10 * 60_000;
let stopping = false;
let lastSchedule = 0;

async function tick() {
  await drainJobs();
  await sendPendingEmails();
  if (Date.now() - lastSchedule >= SCHEDULE_EVERY_MS) {
    lastSchedule = Date.now();
    await runDailyTasks();
    const r = await runIntegrationSchedules();
    if (r.length) console.log(`[integrations] ${JSON.stringify(r)}`);
  }
}

async function main() {
  console.log(`[worker] started (tick ${TICK_MS} ms)`);
  while (!stopping) {
    try {
      await tick();
    } catch (e) {
      console.error(`[worker] tick failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  await prisma.$disconnect();
  console.log('[worker] stopped');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopping = true; });
main();
