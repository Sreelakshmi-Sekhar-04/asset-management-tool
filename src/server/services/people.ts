import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { Actor } from '../actor';

/**
 * One list of people for the "Users & Employees" page. An employee (someone who can hold
 * assets) and a user (someone who can sign in) are the same person when the user is linked to
 * the employee, so they share one row; nothing is copied between the two tables.
 * Administrators and IT operators also see sign-in accounts with no employee record; branch
 * users see only employees in their own branch, as before.
 */
export interface PeopleQuery {
  name?: string; employeeCode?: string; departmentId?: string; locationId?: string;
  /** ADMIN | IT_OPERATOR | BRANCH_USER | NONE (no sign-in) | ANY (has a sign-in) */
  signIn?: string; active?: string; holding?: string;
  sort?: string; dir?: 'asc' | 'desc'; skip: number; take: number;
}

export interface PersonRow {
  id: string; employeeId: string | null; userId: string | null;
  name: string; email: string | null; employeeCode: string | null; source: string | null;
  department: string | null; departmentId: string | null; location: string | null; locationId: string | null;
  manager: string | null; employeeActive: boolean | null;
  role: string | null; userActive: boolean | null; userName: string | null; userEmail: string | null; userLocationId: string | null; userLocation: string | null;
  lockedUntil: Date | null; lastLoginAt: Date | null; hasPassword: boolean | null;
  heldAssets: number;
}

const SORT: Record<string, Prisma.Sql> = {
  name: Prisma.sql`lower(p.name)`,
  employeeCode: Prisma.sql`p."employeeCode"`,
  email: Prisma.sql`lower(p.email)`,
  role: Prisma.sql`p.role`,
  heldAssets: Prisma.sql`p."heldAssets"`,
};

export async function listPeople(actor: Actor, q: PeopleQuery) {
  const isBranch = actor.role === 'BRANCH_USER';
  const where: Prisma.Sql[] = [];
  if (isBranch) where.push(Prisma.sql`p."employeeId" IS NOT NULL AND p."locIdPath" LIKE ${`${actor.scopeIdPath ?? '/__none__/'}%`}`);
  const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (q.name) where.push(Prisma.sql`(p.name ILIKE ${like(q.name)} OR p.email ILIKE ${like(q.name)} OR p."userEmail" ILIKE ${like(q.name)})`);
  if (q.employeeCode) where.push(Prisma.sql`p."employeeCode" ILIKE ${like(q.employeeCode)}`);
  if (q.departmentId) where.push(Prisma.sql`p."departmentId" = ${q.departmentId}`);
  if (q.locationId) {
    const loc = await prisma.location.findUnique({ where: { id: q.locationId }, select: { idPath: true } });
    where.push(loc ? Prisma.sql`p."locIdPath" LIKE ${`${loc.idPath}%`}` : Prisma.sql`FALSE`);
  }
  if (isBranch) { /* sign-in filters are not offered to branch users */ }
  else if (q.signIn === 'NONE') where.push(Prisma.sql`p."userId" IS NULL`);
  else if (q.signIn === 'ANY') where.push(Prisma.sql`p."userId" IS NOT NULL`);
  else if (q.signIn) where.push(Prisma.sql`p.role::text = ${q.signIn}`);
  if (q.active === 'true' || q.active === 'false') where.push(Prisma.sql`p.active = ${q.active === 'true'}`);
  if (q.holding === 'true') where.push(Prisma.sql`p."heldAssets" > 0`);
  const cond = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty;
  const order = SORT[q.sort ?? ''] ?? SORT.name;
  const dir = q.dir === 'desc' ? Prisma.sql`DESC NULLS LAST` : Prisma.sql`ASC NULLS LAST`;

  const base = Prisma.sql`
    SELECT
      COALESCE(e.id, u.id) AS id, e.id AS "employeeId", u.id AS "userId",
      COALESCE(e.name, u.name) AS name, COALESCE(e.email, u.email) AS email,
      e."employeeCode", e.source, d.name AS department, e."departmentId",
      COALESCE(el."namePath", ul."namePath") AS location, COALESCE(e."locationId", u."locationId") AS "locationId",
      COALESCE(el."idPath", ul."idPath") AS "locIdPath",
      m.name AS manager, e.active AS "employeeActive",
      u.role, u.active AS "userActive", u.name AS "userName", u.email AS "userEmail", u."locationId" AS "userLocationId", ul."namePath" AS "userLocation",
      u."lockedUntil", u."lastLoginAt", (u."passwordHash" IS NOT NULL) AS "hasPassword",
      COALESCE(e.active, u.active) AS active,
      (SELECT count(*)::int FROM assets a WHERE a."holderEmployeeId" = e.id AND a.status <> 'RETIRED') AS "heldAssets"
    FROM employees e
    FULL OUTER JOIN users u ON u."employeeId" = e.id
    LEFT JOIN departments d ON d.id = e."departmentId"
    LEFT JOIN locations el ON el.id = e."locationId"
    LEFT JOIN locations ul ON ul.id = u."locationId"
    LEFT JOIN employees m ON m.id = e."managerId"`;

  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw<(PersonRow & { locIdPath: string | null; active: boolean })[]>`
      SELECT * FROM (${base}) p ${cond} ORDER BY ${order} ${dir}, p.id ASC OFFSET ${q.skip} LIMIT ${q.take}`,
    prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM (${base}) p ${cond}`,
  ]);
  // A branch user must not learn about a manager outside their own branch (TC-ACC-20).
  if (isBranch) {
    const managers = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId!).filter(Boolean) } }, select: { id: true, manager: { select: { location: { select: { idPath: true } } } } } });
    const outside = new Set(managers.filter((x) => x.manager && !(x.manager.location?.idPath ?? '').startsWith(actor.scopeIdPath ?? '/__none__/')).map((x) => x.id));
    for (const r of rows) if (r.employeeId && outside.has(r.employeeId)) r.manager = null;
  }
  // Sign-in details are only for those who manage sign-ins.
  const showSignIn = actor.role === 'ADMIN' || actor.role === 'IT_OPERATOR';
  return {
    rows: rows.map(({ locIdPath: _p, active: _a, ...r }) => (showSignIn ? r : { ...r, userId: null, role: null, userActive: null, userName: null, userEmail: null, userLocationId: null, userLocation: null, lockedUntil: null, lastLoginAt: null, hasPassword: null })),
    total,
  };
}
