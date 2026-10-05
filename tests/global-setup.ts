import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { testDatabaseUrl } from './test-db';

/**
 * Creates a dedicated test database (never the development database) and applies
 * every migration to it, so tests run against the real triggers and constraints.
 * The database name must end in "_test"; it is recreated on each run.
 */
export default async function setup() {
  const url = testDatabaseUrl();
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/_test$/.test(name)) throw new Error(`Refusing to use "${name}" for tests: the test database name must end in _test.`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const c = new PrismaClient({ datasourceUrl: admin.toString() });
  await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await c.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  await c.$disconnect();
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
