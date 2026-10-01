import { PrismaClient, Prisma } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** A Prisma client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** Run fn in a serializable-enough transaction with generous limits for bulk work. */
export function tx<T>(fn: (t: Prisma.TransactionClient) => Promise<T>, opts?: { timeoutMs?: number }) {
  return prisma.$transaction(fn, { timeout: opts?.timeoutMs ?? 60_000, maxWait: 15_000 });
}
