import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { forbidden, notFound } from '@/lib/errors';
import type { Actor } from './actor';

/**
 * Row-level location scoping (§A2.1 hard rule). Every service read/write for a
 * branch user passes through these helpers; UI hiding is never relied upon.
 */
export function assetScope(actor: Actor): Prisma.AssetWhereInput {
  if (actor.role !== 'BRANCH_USER') return {};
  return { location: { idPath: { startsWith: actor.scopeIdPath ?? '/__none__/' } } };
}

export function locationScope(actor: Actor): Prisma.LocationWhereInput {
  if (actor.role !== 'BRANCH_USER') return {};
  return { idPath: { startsWith: actor.scopeIdPath ?? '/__none__/' } };
}

export function employeeScope(actor: Actor): Prisma.EmployeeWhereInput {
  if (actor.role !== 'BRANCH_USER') return {};
  return { location: { idPath: { startsWith: actor.scopeIdPath ?? '/__none__/' } } };
}

/** Transfers visible to a branch: outbound from, or inbound to, their subtree. */
export function transferScope(actor: Actor): Prisma.TransferWhereInput {
  if (actor.role !== 'BRANCH_USER') return {};
  const p = actor.scopeIdPath ?? '/__none__/';
  return { OR: [{ fromLocation: { idPath: { startsWith: p } } }, { toLocation: { idPath: { startsWith: p } } }] };
}

export function inScopePath(actor: Actor, idPath: string | null | undefined): boolean {
  if (actor.role !== 'BRANCH_USER') return true;
  return !!idPath && !!actor.scopeIdPath && idPath.startsWith(actor.scopeIdPath);
}

export async function locationInScope(actor: Actor, locationId: string | null | undefined, db: Db = prisma) {
  if (actor.role !== 'BRANCH_USER') return true;
  if (!locationId) return false;
  const loc = await db.location.findUnique({ where: { id: locationId }, select: { idPath: true } });
  return inScopePath(actor, loc?.idPath);
}

export async function assertLocationInScope(actor: Actor, locationId: string | null | undefined, db: Db = prisma) {
  if (!(await locationInScope(actor, locationId, db))) throw forbidden('That location is outside your branch scope.');
}

export async function scopedLocationIds(actor: Actor, db: Db = prisma): Promise<string[] | null> {
  if (actor.role !== 'BRANCH_USER') return null;
  const rows = await db.location.findMany({ where: locationScope(actor), select: { id: true } });
  return rows.map((r) => r.id);
}

/** Load an asset the actor may see, or 404 (never disclosing out-of-scope records). */
export async function getScopedAsset(actor: Actor, idOrCode: string, db: Db = prisma) {
  // Asset IDs follow a configurable format, so match either the internal id or the Asset ID.
  const where: Prisma.AssetWhereInput = { OR: [{ id: idOrCode }, { assetCode: idOrCode.trim().toUpperCase() }] };
  const asset = await db.asset.findFirst({ where: { AND: [where, assetScope(actor)] } });
  if (!asset) throw notFound('Asset');
  return asset;
}

export function requireRole(actor: Actor, ...roles: Actor['role'][]) {
  if (!roles.includes(actor.role)) throw forbidden();
}
