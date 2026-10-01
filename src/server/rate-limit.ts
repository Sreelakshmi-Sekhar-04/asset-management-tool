import { prisma } from '@/lib/db';

/**
 * Fixed-window rate limiter stored in Postgres so it works across web instances.
 * Returns true if the call is allowed.
 */
export async function hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits ("key", "windowStart", "count") VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN rate_limits."windowStart" = EXCLUDED."windowStart" THEN rate_limits."count" + 1 ELSE 1 END,
      "windowStart" = EXCLUDED."windowStart"
    RETURNING "count"`;
  return (rows[0]?.count ?? 1) <= limit;
}
