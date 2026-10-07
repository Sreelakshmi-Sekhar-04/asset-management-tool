import { route } from '@/server/http';
import { prisma } from '@/lib/db';
import { badRequest } from '@/lib/errors';
import { assertInOrg } from '@/server/org';
import { updateLocation } from '@/server/services/locations';

export const PATCH = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => {
  const input = await req.json() as { type?: string; parentId?: string | null };
  const loc = await prisma.location.findUnique({ where: { id: params.id }, select: { parentId: true, idPath: true } });
  if (loc) assertInOrg(actor, loc.idPath, 'That location belongs to a different organization.');
  // Organizations are edited under Configuration → Organizations, and a location cannot become one.
  if (loc && !loc.parentId) throw badRequest('Edit an organization under Configuration → Organizations.');
  if (input.type === 'ORGANIZATION' || input.parentId === null) throw badRequest('A location needs a parent. Organizations are created under Configuration → Organizations.');
  if (input.parentId) {
    const parent = await prisma.location.findUnique({ where: { id: input.parentId }, select: { idPath: true } });
    assertInOrg(actor, parent?.idPath, 'That parent belongs to a different organization.');
  }
  return updateLocation(actor, params.id, input);
});
