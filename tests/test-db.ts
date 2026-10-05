/** TEST_DATABASE_URL, or DATABASE_URL with "_test" appended to the database name. */
export function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/itam';
  const u = new URL(base);
  if (!u.pathname.endsWith('_test')) u.pathname = `${u.pathname}_test`;
  return u.toString();
}
