import { NextResponse } from 'next/server';
import { z } from 'zod';
import { route, body } from '@/server/http';
import { badRequest, forbidden } from '@/lib/errors';
import { listOrganizations, ORG_COOKIE } from '@/server/org';
import { audit } from '@/server/audit';
import { prisma } from '@/lib/db';

/**
 * Choose the organization to work in. It is kept in a cookie and resolved server-side on every
 * request, so every screen keeps the same context while the user navigates.
 */
export const POST = route({}, async ({ req, actor }) => {
  const { organizationId } = await body(req, z.object({ organizationId: z.string().min(1) }));
  if (actor.role === 'BRANCH_USER') throw forbidden('A branch user always works in their own organization.');
  const org = (await listOrganizations()).find((o) => o.id === organizationId);
  if (!org) throw badRequest('Unknown organization.');
  if (!org.active) throw badRequest(`${org.name} is inactive. Activate it under Configuration → Organizations first.`);
  await audit(prisma, actor, { action: 'ORGANIZATION_SELECTED', entityType: 'Location', entityId: org.id, entityLabel: org.name });
  const res = NextResponse.json({ organizationId: org.id, name: org.name });
  res.cookies.set(ORG_COOKIE, org.id, { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.FORCE_HTTPS === 'true', maxAge: 365 * 86_400 });
  return res;
});
