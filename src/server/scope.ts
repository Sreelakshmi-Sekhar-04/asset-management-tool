import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { forbidden, notFound } from '@/lib/errors';
import type { Actor } from './actor';

/**
 * Row-level scoping. Two filters apply to every service read/write, and both are server-side:
 *   • the selected organization (§11-18) — the root of the location tree the caller is working in;
 *   • the branch subtree of a branch user (§A2.1 hard rule).
 * UI hiding is never relied upon.
 */

/** The location-path prefix every record must sit under: the branch subtree, else the organization. */
export function scopePath(actor: Actor): string | null {
  if (actor.role === 'BRANCH_USER') return actor.scopeIdPath ?? '/__none__/';
  return actor.orgIdPath ?? null;
}

export function assetScope(actor: Actor): Prisma.AssetWhereInput {
  const p = scopePath(actor);
  return p ? { location: { idPath: { startsWith: p } } } : {};
}

export function locationScope(actor: Actor): Prisma.LocationWhereInput {
  const p = scopePath(actor);
  return p ? { idPath: { startsWith: p } } : {};
}

export function employeeScope(actor: Actor): Prisma.EmployeeWhereInput {
  const p = scopePath(actor);
  return p ? { location: { idPath: { startsWith: p } } } : {};
}

/** Departments belong to one organization, or to none (shared by all of them). */
export function departmentScope(actor: Actor): Prisma.DepartmentWhereInput {
  if (!actor.orgId) return {};
  return { OR: [{ organizationId: actor.orgId }, { organizationId: null }] };
}

/** Transfer history visible to the caller: either end of the route inside their scope. */
export function transferScope(actor: Actor): Prisma.TransferWhereInput {
  const p = scopePath(actor);
  if (!p) return {};
  return { OR: [{ fromLocation: { idPath: { startsWith: p } } }, { toLocation: { idPath: { startsWith: p } } }] };
}

export function inScopePath(actor: Actor, idPath: string | null | undefined): boolean {
  const p = scopePath(actor);
  if (!p) return true;
  return !!idPath && idPath.startsWith(p);
}

export async function locationInScope(actor: Actor, locationId: string | null | undefined, db: Db = prisma) {
  if (!scopePath(actor)) return true;
  if (!locationId) return false;
  const loc = await db.location.findUnique({ where: { id: locationId }, select: { idPath: true } });
  return inScopePath(actor, loc?.idPath);
}

export async function assertLocationInScope(actor: Actor, locationId: string | null | undefined, db: Db = prisma) {
  if (!(await locationInScope(actor, locationId, db))) {
    throw forbidden(actor.role === 'BRANCH_USER' ? 'That location is outside your branch scope.' : 'That location belongs to another organization.');
  }
}

export async function scopedLocationIds(actor: Actor, db: Db = prisma): Promise<string[] | null> {
  if (!scopePath(actor)) return null;
  const rows = await db.location.findMany({ where: locationScope(actor), select: { id: true } });
  return rows.map((r) => r.id);
}

/** Load an asset the actor may see, or 404 (never disclosing out-of-scope records). */
export async function getScopedAsset(actor: Actor, idOrCode: string, db: Db = prisma) {
  const where: Prisma.AssetWhereInput = /^AST-\d+$/i.test(idOrCode) ? { assetCode: idOrCode.toUpperCase() } : { id: idOrCode };
  const asset = await db.asset.findFirst({ where: { AND: [where, assetScope(actor)] } });
  if (!asset) throw notFound('Asset');
  return asset;
}

export function requireRole(actor: Actor, ...roles: Actor['role'][]) {
  if (!roles.includes(actor.role)) throw forbidden();
}
