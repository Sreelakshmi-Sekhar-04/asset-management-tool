import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';

/** Durable job queue in Postgres; workers claim with FOR UPDATE SKIP LOCKED. */
export async function enqueue(type: string, payload: Prisma.InputJsonValue = {}, db: Db = prisma, runAfter = new Date()) {
  return db.job.create({ data: { type, payload, runAfter } });
}

export async function claimNext() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE jobs SET status = 'RUNNING', "lockedAt" = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE (status = 'QUEUED' AND "runAfter" <= now())
         OR (status = 'RUNNING' AND "lockedAt" < now() - interval '30 minutes')
      ORDER BY "runAfter" ASC
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id`;
  if (!rows.length) return null;
  const job = await prisma.job.findUnique({ where: { id: rows[0].id } });
  return job;
}

export async function finish(id: string, error?: string) {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return;
  if (error && job.attempts < 3) {
    await prisma.job.update({ where: { id }, data: { status: 'QUEUED', lastError: error, runAfter: new Date(Date.now() + job.attempts * 30_000), lockedAt: null } });
  } else {
    await prisma.job.update({ where: { id }, data: { status: error ? 'FAILED' : 'DONE', lastError: error ?? null, finishedAt: new Date() } });
  }
}
