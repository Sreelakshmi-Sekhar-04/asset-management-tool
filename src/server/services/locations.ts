import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma, tx, type Db } from '@/lib/db';
import { badRequest, conflict, notFound } from '@/lib/errors';
import type { Actor } from '../actor';
import { audit, diff } from '../audit';
import { inScopePath, locationScope } from '../scope';

export const locationInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120).refine((s) => !s.includes('/'), 'Name cannot contain "/"'),
  parentId: z.string().nullable().optional(),
  type: z.enum(['REGION', 'STATE', 'BRANCH', 'SITE', 'OTHER']).default('BRANCH'),
  state: z.string().trim().max(80).nullable().optional(),
  code: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
});

export async function listLocations(actor: Actor, opts: { includeInactive?: boolean; all?: boolean } = {}) {
  const rows = await prisma.location.findMany({
    where: { ...(opts.all ? {} : locationScope(actor)), ...(opts.includeInactive ? {} : { active: true }) },
    orderBy: { namePath: 'asc' },
  });
  const counts = await prisma.asset.groupBy({ by: ['locationId'], where: { status: { not: 'RETIRED' } }, _count: true });
  const cmap = new Map(counts.map((c) => [c.locationId, c._count]));
  // Destination pickers list every location by name, but asset counts are only disclosed within scope.
  return rows.map((r) => ({ ...r, assetCount: inScopePath(actor, r.idPath) ? cmap.get(r.id) ?? 0 : null, effectiveState: effectiveStateFromRows(r, rows) }));
}

function effectiveStateFromRows(r: { state: string | null; parentId: string | null }, rows: { id: string; state: string | null; parentId: string | null }[]): string | null {
  let cur: typeof r | undefined = r;
  const byId = new Map(rows.map((x) => [x.id, x]));
  while (cur) {
    if (cur.state) return cur.state;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

/** State attribute of the node or its nearest ancestor that has one (used for the inter-state flag). */
export async function effectiveState(db: Db, locationId: string): Promise<string | null> {
  const loc = await db.location.findUnique({ where: { id: locationId } });
  if (!loc) return null;
  if (loc.state) return loc.state;
  const ids = loc.idPath.split('/').filter(Boolean).reverse();
  const anc = await db.location.findMany({ where: { id: { in: ids } }, select: { id: true, state: true } });
  const m = new Map(anc.map((a) => [a.id, a.state]));
  for (const id of ids) if (m.get(id)) return m.get(id)!;
  return null;
}

export async function createLocation(actor: Actor, input: z.infer<typeof locationInput>, db?: Db) {
  const run = async (t: Db) => {
    const data = locationInput.parse(input);
    const parent = data.parentId ? await t.location.findUnique({ where: { id: data.parentId } }) : null;
    if (data.parentId && !parent) throw badRequest('Parent location not found.');
    const dup = await t.location.findFirst({ where: { parentId: data.parentId ?? null, name: { equals: data.name, mode: 'insensitive' } } });
    if (dup) throw conflict(`A location named "${data.name}" already exists under ${parent?.namePath ?? 'the root'}.`);
    const id = randomUUID();
    const loc = await t.location.create({
      data: {
        id, name: data.name, type: data.type, state: data.state || null, code: data.code || null, email: data.email || null,
        parentId: parent?.id ?? null,
        idPath: `${parent?.idPath ?? '/'}${id}/`,
        namePath: parent ? `${parent.namePath} / ${data.name}` : data.name,
        depth: parent ? parent.depth + 1 : 0,
      },
    });
    await audit(t, actor, { action: 'LOCATION_CREATED', entityType: 'Location', entityId: loc.id, entityLabel: loc.namePath, after: loc, locationIds: [loc.id] });
    return loc;
  };
  return db ? run(db) : tx(run);
}

export async function updateLocation(actor: Actor, id: string, input: Partial<z.infer<typeof locationInput>> & { active?: boolean }) {
  return tx(async (t) => {
    const loc = await t.location.findUnique({ where: { id } });
    if (!loc) throw notFound('Location');
    const data = locationInput.partial().extend({ active: z.boolean().optional() }).parse(input);

    if (data.active === false && loc.active) {
      const count = await t.asset.count({ where: { status: { not: 'RETIRED' }, location: { idPath: { startsWith: loc.idPath } } } });
      if (count > 0) throw conflict(`Cannot deactivate ${loc.namePath}: it (or a location beneath it) still holds ${count} asset${count === 1 ? '' : 's'}.`);
      const users = await t.user.count({ where: { active: true, location: { idPath: { startsWith: loc.idPath } } } });
      if (users > 0) throw conflict(`Cannot deactivate ${loc.namePath}: ${users} active user account(s) are bound to it.`);
    }

    let parent = loc.parentId ? await t.location.findUnique({ where: { id: loc.parentId } }) : null;
    const parentChanged = data.parentId !== undefined && (data.parentId ?? null) !== loc.parentId;
    if (parentChanged) {
      parent = data.parentId ? await t.location.findUnique({ where: { id: data.parentId } }) : null;
      if (data.parentId && !parent) throw badRequest('Parent location not found.');
      if (parent && parent.idPath.startsWith(loc.idPath)) throw badRequest('A location cannot be moved beneath itself or its descendants.');
    }
    const name = data.name ?? loc.name;
    if (data.name && data.name !== loc.name || parentChanged) {
      const dup = await t.location.findFirst({ where: { parentId: parent?.id ?? null, name: { equals: name, mode: 'insensitive' }, id: { not: id } } });
      if (dup) throw conflict(`A location named "${name}" already exists there.`);
    }
    const newIdPath = `${parent?.idPath ?? '/'}${loc.id}/`;
    const newNamePath = parent ? `${parent.namePath} / ${name}` : name;
    const newDepth = parent ? parent.depth + 1 : 0;

    const updated = await t.location.update({
      where: { id },
      data: {
        name, type: data.type, state: data.state === undefined ? undefined : data.state || null,
        code: data.code === undefined ? undefined : data.code || null, email: data.email === undefined ? undefined : data.email || null,
        active: data.active, parentId: parentChanged ? parent?.id ?? null : undefined,
        idPath: newIdPath, namePath: newNamePath, depth: newDepth,
      },
    });
    // Recompute descendant paths (TC-CFG-04: every descendant path updates; asset IDs untouched).
    if (newIdPath !== loc.idPath || newNamePath !== loc.namePath) {
      await t.$executeRaw`
        UPDATE locations SET
          "idPath" = ${newIdPath} || substr("idPath", ${loc.idPath.length + 1}),
          "namePath" = ${newNamePath} || substr("namePath", ${loc.namePath.length + 1}),
          "depth" = "depth" + ${newDepth - loc.depth}
        WHERE "idPath" LIKE ${loc.idPath + '%'} AND id <> ${loc.id}`;
    }
    const d = diff(loc as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>);
    await audit(t, actor, {
      action: data.active === false ? 'LOCATION_DEACTIVATED' : data.active === true && !loc.active ? 'LOCATION_ACTIVATED' : 'LOCATION_UPDATED',
      entityType: 'Location', entityId: id, entityLabel: updated.namePath, before: d.before, after: d.after, locationIds: [id],
    });
    return updated;
  });
}

/** Resolve "Region/Branch" style paths, case-insensitively. Returns the node or null. */
export async function resolveLocationPath(db: Db, path: string) {
  const parts = path.split(/[/\\>]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const normalized = parts.join(' / ').toLowerCase();
  const exact = await db.location.findFirst({ where: { namePath: { equals: parts.join(' / '), mode: 'insensitive' } } });
  if (exact) return exact;
  // Allow a unique trailing match, e.g. "Angamaly" or "Kerala/Angamaly" when the full path is "South / Kerala / Angamaly".
  const candidates = await db.location.findMany({ where: { namePath: { endsWith: parts.join(' / '), mode: 'insensitive' } } });
  const matches = candidates.filter((c) => c.namePath.toLowerCase() === normalized || c.namePath.toLowerCase().endsWith(' / ' + normalized));
  return matches.length === 1 ? matches[0] : null;
}
