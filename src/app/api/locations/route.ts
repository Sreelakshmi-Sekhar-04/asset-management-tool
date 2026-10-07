import { route, body, q } from '@/server/http';
import { badRequest } from '@/lib/errors';
import { prisma } from '@/lib/db';
import { assertInOrg } from '@/server/org';
import { createLocation, listLocations, locationInput } from '@/server/services/locations';

export const GET = route({}, async ({ actor, url }) => listLocations(actor, { includeInactive: q(url, 'includeInactive') === 'true', all: q(url, 'all') === 'true' }));
export const POST = route({ roles: ['ADMIN'] }, async ({ req, actor }) => {
  const data = await body(req, locationInput);
  // Organizations are created centrally, under Configuration → Organizations.
  if (data.type === 'ORGANIZATION' || !data.parentId) throw badRequest('A location needs a parent. Organizations are created under Configuration → Organizations.');
  const parent = await prisma.location.findUnique({ where: { id: data.parentId }, select: { idPath: true } });
  assertInOrg(actor, parent?.idPath, 'That parent belongs to a different organization.');
  return createLocation(actor, data);
});
