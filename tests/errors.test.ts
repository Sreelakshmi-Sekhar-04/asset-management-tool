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

  it('a database without a new enum value is reported as not migrated', async () => {
    const raw = await prisma.$queryRaw`SELECT 'NOT_A_KIND'::"MovementKind"`.catch((e) => e);
    expect(toAppError(raw)).toMatchObject({ status: 503, code: 'DB_NOT_MIGRATED' });
  });

  it('a client generated before the update is reported with the "prisma generate" fix', async () => {
    // What an old client does with an enum value or a field it has never heard of.
    const badEnum = await prisma.assetMovement.count({ where: { kind: { in: ['NOT_A_KIND' as never] } } }).catch((e) => e);
    expect(toAppError(badEnum)).toMatchObject({ status: 503, code: 'CLIENT_OUT_OF_DATE' });
    const badField = await prisma.department.findMany({ where: { notAField: 'x' } as never }).catch((e) => e);
    const err = toAppError(badField);
    expect(err).toMatchObject({ status: 503, code: 'CLIENT_OUT_OF_DATE' });
    expect(err.message).toContain('npx prisma generate');
  });

  it('still reports other unexpected failures as a generic 500', () => {
    expect(toAppError(new Error('boom'))).toMatchObject({ status: 500, code: 'INTERNAL' });
  });
});
