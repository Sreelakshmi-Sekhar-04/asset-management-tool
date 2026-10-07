import { prisma, type Db } from '@/lib/db';
import { badRequest, forbidden } from '@/lib/errors';
import type { Actor } from './actor';

/**
 * Organization context. An organization is the root of the location tree (the head quarter);
 * every location, department, employee and asset belongs to exactly one, through the
 * location path. The selected organization is kept in a cookie and resolved on the server for
 * every request, so filtering never depends on the browser sending the right query string.
 */
export const ORG_COOKIE = 'itam_org';

export interface Org {
  id: string;
  name: string;
  idPath: string;
  active: boolean;
}

export async function listOrganizations(db: Db = prisma): Promise<Org[]> {
  const rows = await db.location.findMany({
    where: { parentId: null },
    select: { id: true, name: true, idPath: true, active: true },
    orderBy: { name: 'asc' },
  });
  return rows;
}

/** The organization a location belongs to: the first id in its path. */
export function orgIdOfPath(idPath: string | null | undefined): string | null {
  const first = (idPath ?? '').split('/').filter(Boolean)[0];
  return first ?? null;
}

export async function orgOfLocation(db: Db, locationId: string | null | undefined): Promise<string | null> {
  if (!locationId) return null;
  const loc = await db.location.findUnique({ where: { id: locationId }, select: { idPath: true } });
  return orgIdOfPath(loc?.idPath);
}

/**
 * Resolve the organization for a signed-in user: their own for a branch user (never
 * switchable), otherwise the one they picked, falling back to the only / first organization.
 */
export async function resolveOrg(
  db: Db,
  user: { role: Actor['role']; scopeIdPath: string | null },
  selectedId: string | undefined | null,
): Promise<Org | null> {
  const orgs = await listOrganizations(db);
  if (!orgs.length) return null;
  if (user.role === 'BRANCH_USER') {
    const own = orgIdOfPath(user.scopeIdPath);
    return orgs.find((o) => o.id === own) ?? null;
  }
  // An inactive organization is not offered; fall back to the first active one.
  return orgs.find((o) => o.id === selectedId && o.active) ?? orgs.find((o) => o.active) ?? orgs[0];
}

/** Refuse a cross-organization reference regardless of what the UI offered (§19). */
export function assertSameOrg(assetOrgId: string | null, targetOrgId: string | null, what: string) {
  if (!assetOrgId || !targetOrgId) return;
  if (assetOrgId !== targetOrgId) throw badRequest(`That ${what} belongs to a different organization. An asset can only be assigned or transferred within its own organization.`);
}

export function assertInOrg(actor: Actor, idPath: string | null | undefined, message: string) {
  if (!actor.orgIdPath) return;
  if (!idPath || !idPath.startsWith(actor.orgIdPath)) throw forbidden(message);
}
