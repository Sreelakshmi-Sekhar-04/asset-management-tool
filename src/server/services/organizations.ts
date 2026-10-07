import { z } from 'zod';
import { prisma, tx } from '@/lib/db';
import { badRequest, notFound } from '@/lib/errors';
import type { Actor } from '../actor';
import { createLocation, updateLocation } from './locations';

/**
 * Configuration → Organizations. An organization is the head quarter at the top of a location
 * tree, so it is stored as a root location of type ORGANIZATION: everything beneath it
 * (locations, departments, employees, assets) belongs to it through the location path. This is
 * the only place organizations are created; the Locations screen adds locations under one.
 */
export const organizationInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120).refine((s) => !s.includes('/'), 'Name cannot contain "/"'),
  active: z.boolean().default(true),
});

export async function listOrganizationsWithCounts() {
  const orgs = await prisma.location.findMany({ where: { parentId: null }, orderBy: { name: 'asc' } });
  return Promise.all(orgs.map(async (o) => {
    const inOrg = { idPath: { startsWith: o.idPath } };
    const [locations, employees, assets] = await Promise.all([
      prisma.location.count({ where: { ...inOrg, id: { not: o.id } } }),
      prisma.employee.count({ where: { location: inOrg } }),
      prisma.asset.count({ where: { location: inOrg, status: { not: 'RETIRED' } } }),
    ]);
    return { id: o.id, name: o.name, active: o.active, createdAt: o.createdAt, updatedAt: o.updatedAt, locations, employees, assets };
  }));
}

export async function createOrganization(actor: Actor, input: unknown) {
  const data = organizationInput.parse(input);
  return tx(async (t) => {
    const org = await createLocation(actor, { name: data.name, type: 'ORGANIZATION', parentId: null }, t);
    return data.active ? org : t.location.update({ where: { id: org.id }, data: { active: false } });
  });
}

export async function updateOrganization(actor: Actor, id: string, input: unknown) {
  const data = organizationInput.partial().parse(input);
  const org = await prisma.location.findUnique({ where: { id } });
  if (!org || org.parentId) throw notFound('Organization');
  if (data.active === false && (await prisma.location.count({ where: { parentId: null, active: true, id: { not: id } } })) === 0) {
    throw badRequest(`${org.name} is the only active organization. Add or activate another one first.`);
  }
  return updateLocation(actor, id, { ...(data.name !== undefined && { name: data.name }), ...(data.active !== undefined && { active: data.active }) });
}
