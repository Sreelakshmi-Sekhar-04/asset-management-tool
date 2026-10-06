import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { toAppError } from '@/lib/errors';

describe('database not migrated', () => {
  it('turns a missing table into a clear "run db:migrate" error instead of a generic 500', async () => {
    const known = new Prisma.PrismaClientKnownRequestError('The table `public.x` does not exist in the current database.', { code: 'P2021', clientVersion: Prisma.prismaVersion.client });
    expect(toAppError(known)).toMatchObject({ status: 503, code: 'DB_NOT_MIGRATED' });

    const raw = await prisma.$queryRaw`SELECT 1 FROM itam_table_that_does_not_exist`.catch((e) => e);
    const err = toAppError(raw);
    expect(err).toMatchObject({ status: 503, code: 'DB_NOT_MIGRATED' });
    expect(err.message).toContain('npm run db:migrate');
  });

  it('still reports other unexpected failures as a generic 500', () => {
    expect(toAppError(new Error('boom'))).toMatchObject({ status: 500, code: 'INTERNAL' });
  });
});
