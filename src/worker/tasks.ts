import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/format';
import { runCommit, runValidation } from '@/server/import/engine';
import { claimNext, finish } from '@/server/jobs/queue';
import { runTransferAging } from '@/server/services/aging';
import { purgeExpiredDocuments } from '@/server/services/documents';
import { scheduledIntegrations } from '@/server/services/integrations';
import { runRenewalReminders } from '@/server/services/renewables';
import { runVerificationScheduler } from '@/server/services/verification';

export const JOB_HANDLERS: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
  'import.validate': (p) => runValidation(p.jobId as string),
  'import.commit': (p) => runCommit(p.jobId as string),
};

/** Process queued jobs until the queue is empty or the limit is reached. */
export async function drainJobs(limit = 20) {
  let n = 0;
  while (n < limit) {
    const job = await claimNext();
    if (!job) break;
    n++;
    const handler = JOB_HANDLERS[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job.payload as Record<string, unknown>);
      await finish(job.id);
    } catch (e) {
      console.error(`[job] ${job.type} ${job.id} failed: ${(e as Error).message}`);
      await finish(job.id, (e as Error).message.slice(0, 2000));
    }
  }
  return n;
}

/** Daily tasks run once per IST day, claimed through ScheduledEvent so multiple workers never double-run. */
export const DAILY_TASKS: Record<string, (asOf: string) => Promise<unknown>> = {
  'renewal-reminders': (d) => runRenewalReminders(d),
  'verification-scheduler': (d) => runVerificationScheduler(d),
  'transfer-aging': (d) => runTransferAging(d),
  'document-purge': () => purgeExpiredDocuments(),
  housekeeping: () => housekeeping(),
};

export async function runDailyTasks(asOf = todayIST()) {
  const results: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(DAILY_TASKS)) {
    const key = `daily:${name}:${asOf}`;
    const claimed = await prisma.scheduledEvent.createMany({ data: [{ key }], skipDuplicates: true });
    if (!claimed.count) continue;
    try {
      results[name] = await fn(asOf);
      console.log(`[daily] ${name} ${asOf}: ${JSON.stringify(results[name])}`);
    } catch (e) {
      // Release the claim so the next tick retries.
      await prisma.scheduledEvent.delete({ where: { key } }).catch(() => undefined);
      console.error(`[daily] ${name} failed: ${(e as Error).message}`);
    }
  }
  return results;
}

export async function runIntegrationSchedules() {
  return scheduledIntegrations();
}

/** Remove expired sessions, used/expired tokens and stale rate-limit windows. */
export async function housekeeping() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [s, t, r, j] = await Promise.all([
    prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: dayAgo } }, { revokedAt: { lt: dayAgo } }] } }),
    prisma.authToken.deleteMany({ where: { OR: [{ expiresAt: { lt: dayAgo } }, { usedAt: { lt: dayAgo } }] } }),
    prisma.rateLimit.deleteMany({ where: { windowStart: { lt: dayAgo } } }),
    prisma.job.deleteMany({ where: { status: 'DONE', finishedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } } }),
  ]);
  return { sessions: s.count, tokens: t.count, rateLimits: r.count, jobs: j.count };
}
