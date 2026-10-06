import { route, q } from '@/server/http';
import { listOrganizations } from '@/server/org';
import { createOrganization, listOrganizationsWithCounts } from '@/server/services/organizations';
import { forbidden } from '@/lib/errors';

/**
 * The organizations (head quarters) the caller can work in, and the one currently selected.
 * `?manage=true` is the Configuration → Organizations list: every organization, with counts.
 */
export const GET = route({}, async ({ actor, url }) => {
  if (q(url, 'manage') === 'true') {
    if (actor.role !== 'ADMIN') throw forbidden('Organizations are managed by Administrators.');
    return listOrganizationsWithCounts();
  }
  const orgs = await listOrganizations();
  const mine = actor.role === 'BRANCH_USER' ? orgs.filter((o) => o.id === actor.orgId) : orgs.filter((o) => o.active || o.id === actor.orgId);
  return { organizations: mine.map((o) => ({ id: o.id, name: o.name, active: o.active })), selectedId: actor.orgId, canSwitch: actor.role !== 'BRANCH_USER' };
});

/** Create an organization (Configuration → Organizations only). */
export const POST = route({ roles: ['ADMIN'] }, async ({ req, actor }) => createOrganization(actor, await req.json()));
