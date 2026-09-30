import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma, tx } from '@/lib/db';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import type { Actor } from '../actor';
import { audit, diff } from '../audit';
import { hashPassword, passwordProblems } from '../auth/password';
import { revokeUserSessions, sendInvite, issueToken } from '../auth/session';
import { enqueueEmail } from '../notify';

export const userInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['ADMIN', 'IT_OPERATOR', 'BRANCH_USER']),
  locationId: z.string().nullable().optional(),
  employeeId: z.string().nullable().optional(),
  active: z.boolean().optional(),
  password: z.string().optional(),
  sendInvite: z.boolean().optional(),
});

const publicUser = {
  id: true, email: true, name: true, role: true, locationId: true, employeeId: true, active: true,
  lastLoginAt: true, lockedUntil: true, failedLoginCount: true, invitedAt: true, passwordChangedAt: true, createdAt: true,
  location: { select: { id: true, namePath: true } }, employee: { select: { id: true, name: true, employeeCode: true } },
} satisfies Prisma.UserSelect;

export async function listUsers(params: { search?: string; role?: string; active?: string; skip: number; take: number }) {
  const where: Prisma.UserWhereInput = {
    ...(params.search ? { OR: [{ email: { contains: params.search, mode: 'insensitive' } }, { name: { contains: params.search, mode: 'insensitive' } }] } : {}),
    ...(params.role ? { role: params.role as Prisma.EnumRoleFilter['equals'] } : {}),
    ...(params.active ? { active: params.active === 'true' } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, select: { ...publicUser, passwordHash: true }, orderBy: [{ role: 'asc' }, { email: 'asc' }], skip: params.skip, take: params.take }),
    prisma.user.count({ where }),
  ]);
  return { rows: rows.map(({ passwordHash, ...u }) => ({ ...u, hasPassword: !!passwordHash })), total };
}

export async function getUser(id: string) {
  const u = await prisma.user.findUnique({ where: { id }, select: publicUser });
  if (!u) throw notFound('User');
  return u;
}

async function validateBinding(role: string, locationId: string | null | undefined) {
  if (role === 'BRANCH_USER') {
    if (!locationId) throw badRequest('A branch user must be bound to exactly one location.', [{ field: 'locationId', message: 'Required for branch users' }]);
    const loc = await prisma.location.findUnique({ where: { id: locationId } });
    if (!loc || !loc.active) throw badRequest('The selected location does not exist or is inactive.');
  }
}

export async function createUser(actor: Actor, input: unknown) {
  const data = userInput.parse(input);
  await validateBinding(data.role, data.locationId);
  if (data.password) {
    const p = await passwordProblems(data.password, data.email);
    if (p.length) throw badRequest(`Password must contain ${p.join(', ')}.`);
  }
  const user = await tx(async (t) => {
    if (await t.user.findUnique({ where: { email: data.email } })) throw conflict(`A user with email ${data.email} already exists.`);
    const u = await t.user.create({
      data: {
        email: data.email, name: data.name, role: data.role,
        locationId: data.role === 'BRANCH_USER' ? data.locationId! : null,
        employeeId: data.employeeId || null,
        passwordHash: data.password ? await hashPassword(data.password) : null,
        passwordChangedAt: data.password ? new Date() : null,
      },
      select: publicUser,
    });
    await audit(t, actor, { action: 'USER_CREATED', entityType: 'User', entityId: u.id, entityLabel: u.email, after: { email: u.email, name: u.name, role: u.role, location: u.location?.namePath }, locationIds: [u.locationId] });
    return u;
  });
  if (data.sendInvite !== false && !data.password) await sendInvite(user.id, actor);
  return user;
}

export async function updateUser(actor: Actor, id: string, input: unknown) {
  const data = userInput.partial().omit({ password: true, sendInvite: true }).parse(input);
  return tx(async (t) => {
    const u = await t.user.findUnique({ where: { id } });
    if (!u) throw notFound('User');
    const role = data.role ?? u.role;
    const locationId = role === 'BRANCH_USER' ? (data.locationId !== undefined ? data.locationId : u.locationId) : null;
    await validateBinding(role, locationId);
    // BR-CFG-2: the last active Administrator cannot be deactivated or demoted.
    const losingAdmin = u.role === 'ADMIN' && u.active && (data.active === false || (data.role && data.role !== 'ADMIN'));
    if (losingAdmin) {
      const others = await t.user.count({ where: { role: 'ADMIN', active: true, id: { not: id } } });
      if (others === 0) throw conflict('This is the last active Administrator; it cannot be deactivated or have its role changed.');
    }
    if (data.email && data.email !== u.email && (await t.user.findUnique({ where: { email: data.email } }))) throw conflict(`A user with email ${data.email} already exists.`);
    const updated = await t.user.update({
      where: { id },
      data: { email: data.email, name: data.name, role, locationId, employeeId: data.employeeId === undefined ? undefined : data.employeeId || null, active: data.active },
      select: publicUser,
    });
    const d = diff(u as unknown as Record<string, unknown>, { email: updated.email, name: updated.name, role: updated.role, locationId: updated.locationId, employeeId: updated.employeeId, active: updated.active });
    if (d.changed.length) {
      const action = d.changed.includes('role') ? 'ROLE_CHANGED' : data.active === false ? 'USER_DEACTIVATED' : data.active === true && !u.active ? 'USER_ACTIVATED' : 'USER_UPDATED';
      await audit(t, actor, { action, entityType: 'User', entityId: id, entityLabel: updated.email, before: d.before, after: d.after, locationIds: [u.locationId, updated.locationId] });
    }
    // TC-ACC-18: deactivation (or a scope/role change) terminates existing sessions.
    if (data.active === false || d.changed.includes('role') || d.changed.includes('locationId')) await t.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    return updated;
  });
}

export async function adminResetPassword(actor: Actor, id: string) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('User');
  if (!u.active) throw badRequest('The user is inactive.');
  const token = await issueToken(id, 'RESET');
  const url = `${process.env.APP_URL ?? 'http://localhost:3000'}/reset-password?token=${token}`;
  await enqueueEmail(u.email, 'Password reset by an administrator', `An administrator has reset access to your account. Set a new password within one hour:\n${url}`, `admin-reset:${id}:${Date.now()}`);
  await audit(prisma, actor, { action: 'PASSWORD_RESET_ISSUED', entityType: 'User', entityId: id, entityLabel: u.email });
  return { ok: true };
}

export async function unlockUser(actor: Actor, id: string) {
  const u = await prisma.user.update({ where: { id }, data: { lockedUntil: null, failedLoginCount: 0 } });
  await audit(prisma, actor, { action: 'USER_UNLOCKED', entityType: 'User', entityId: id, entityLabel: u.email });
  return { ok: true };
}

export async function resendInvite(actor: Actor, id: string) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('User');
  await sendInvite(id, actor);
  return { ok: true };
}

export async function me(actor: Actor) {
  if (!actor) throw forbidden();
  return getUser(actor.id);
}

export { revokeUserSessions };
