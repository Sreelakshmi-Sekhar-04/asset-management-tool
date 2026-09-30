import { prisma } from '@/lib/db';
import { forbidden, unauthorized } from '@/lib/errors';
import type { Actor } from '../actor';
import { audit } from '../audit';
import { getSettings } from '../settings';
import { DUMMY_HASH, hashPassword, passwordProblems, verifyPassword } from './password';
import { randomToken, sha256 } from './tokens';
import { hit } from '../rate-limit';
import { badRequest } from '@/lib/errors';
import { enqueueEmail } from '../notify';

export const SESSION_COOKIE = 'itam_session';

const GENERIC_LOGIN_ERROR = 'Invalid email or password, or the account is locked or inactive.';

export async function login(emailRaw: string, password: string, ctx: { ip?: string | null; userAgent?: string | null }) {
  const email = emailRaw.trim().toLowerCase();
  const s = await getSettings();
  if (!(await hit(`login-ip:${ctx.ip ?? 'unknown'}`, 30, 60))) {
    throw new (await import('@/lib/errors')).AppError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Please wait a minute and try again.');
  }
  const user = await prisma.user.findUnique({ where: { email }, include: { location: true } });
  const pseudo = { id: user?.id ?? 'anonymous', email, name: user?.name ?? email, role: user?.role ?? 'BRANCH_USER', ip: ctx.ip, userAgent: ctx.userAgent } as Actor;

  if (!user || !user.passwordHash) {
    await verifyPassword(password, DUMMY_HASH);
    await audit(prisma, { ...pseudo, id: user?.id ?? (null as unknown as string) }, { action: 'LOGIN_FAILED', entityType: 'User', entityId: user?.id, entityLabel: email, details: { reason: user ? 'no password set' : 'unknown email' } });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await verifyPassword(password, DUMMY_HASH);
    await audit(prisma, pseudo, { action: 'LOGIN_FAILED', entityType: 'User', entityId: user.id, entityLabel: email, details: { reason: 'locked' } });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok || !user.active) {
    const count = user.failedLoginCount + (ok ? 0 : 1);
    const lock = !ok && count >= s.lockoutThreshold;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: lock ? 0 : count, lockedUntil: lock ? new Date(Date.now() + s.lockoutMinutes * 60_000) : undefined },
    });
    await audit(prisma, pseudo, { action: 'LOGIN_FAILED', entityType: 'User', entityId: user.id, entityLabel: email, details: { reason: ok ? 'inactive' : 'wrong password', attempt: count } });
    if (lock) await audit(prisma, pseudo, { action: 'ACCOUNT_LOCKED', entityType: 'User', entityId: user.id, entityLabel: email, details: { minutes: s.lockoutMinutes } });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  const token = randomToken();
  const session = await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + s.sessionAbsoluteHours * 3600_000),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await audit(prisma, { ...pseudo, sessionId: session.id }, { action: 'LOGIN', entityType: 'User', entityId: user.id, entityLabel: email });
  return { token, expiresAt: session.expiresAt };
}

/** Resolve a session token to an Actor, enforcing idle timeout (FR-CFG-09) and account state. */
export async function actorFromToken(token: string | undefined | null, ctx: { ip?: string | null; userAgent?: string | null } = {}): Promise<Actor | null> {
  if (!token) return null;
  const s = await getSettings();
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { location: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.active) return null;
  const idleMs = s.sessionIdleMinutes * 60_000;
  if (Date.now() - session.lastActiveAt.getTime() > idleMs) {
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    await audit(prisma, null, { action: 'SESSION_TIMEOUT', entityType: 'User', entityId: session.userId, entityLabel: session.user.email });
    return null;
  }
  if (Date.now() - session.lastActiveAt.getTime() > 30_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastActiveAt: new Date() } });
  }
  const u = session.user;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    locationId: u.role === 'BRANCH_USER' ? u.locationId : null,
    scopeIdPath: u.role === 'BRANCH_USER' ? u.location?.idPath ?? '/__none__/' : null,
    scopeName: u.role === 'BRANCH_USER' ? u.location?.namePath ?? null : null,
    employeeId: u.employeeId,
    sessionId: session.id,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  };
}

export async function logout(actor: Actor) {
  if (actor.sessionId) await prisma.session.update({ where: { id: actor.sessionId }, data: { revokedAt: new Date() } });
  await audit(prisma, actor, { action: 'LOGOUT', entityType: 'User', entityId: actor.id, entityLabel: actor.email });
}

export async function revokeUserSessions(userId: string) {
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

// ── Invite / password reset (single-use, expiring, hashed tokens) ──

export async function issueToken(userId: string, purpose: 'INVITE' | 'RESET') {
  const token = randomToken();
  const hours = purpose === 'INVITE' ? 72 : 1;
  await prisma.authToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.authToken.create({ data: { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + hours * 3600_000) } });
  return token;
}

export async function sendInvite(userId: string, actor: Actor | null) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const token = await issueToken(userId, 'INVITE');
  const url = `${process.env.APP_URL ?? 'http://localhost:3000'}/reset-password?token=${token}&invite=1`;
  await enqueueEmail(user.email, 'You have been invited to IT Asset Management',
    `Hello ${user.name},\n\nAn account has been created for you. Set your password within 72 hours:\n${url}\n`, `invite:${user.id}:${Date.now()}`);
  await prisma.user.update({ where: { id: userId }, data: { invitedAt: new Date() } });
  await audit(prisma, actor, { action: 'USER_INVITED', entityType: 'User', entityId: user.id, entityLabel: user.email });
}

/** Always succeeds from the caller's view so that account existence is not disclosed. */
export async function requestPasswordReset(emailRaw: string, ctx: { ip?: string | null }) {
  const email = emailRaw.trim().toLowerCase();
  if (!(await hit(`reset-ip:${ctx.ip ?? 'unknown'}`, 10, 300))) return;
  const user = await prisma.user.findUnique({ where: { email } });
  await audit(prisma, null, { action: 'PASSWORD_RESET_REQUESTED', entityType: 'User', entityId: user?.id, entityLabel: email, details: { known: !!user } });
  if (!user || !user.active) return;
  const token = await issueToken(user.id, 'RESET');
  const url = `${process.env.APP_URL ?? 'http://localhost:3000'}/reset-password?token=${token}`;
  await enqueueEmail(user.email, 'Password reset', `A password reset was requested for your account. The link is valid for one hour and can be used once:\n${url}\n\nIf you did not request this, ignore this email.`, `reset:${user.id}:${Date.now()}`);
}

export async function completePasswordReset(token: string, newPassword: string) {
  const t = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!t || t.usedAt || t.expiresAt < new Date() || !t.user.active) throw badRequest('This link is invalid or has expired. Request a new one.');
  const problems = await passwordProblems(newPassword, t.user.email);
  if (problems.length) throw badRequest(`Password must contain ${problems.join(', ')}.`, problems.map((m) => ({ field: 'password', message: m })));
  await prisma.$transaction([
    prisma.authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: t.userId }, data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } }),
    prisma.session.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit(prisma, null, { action: t.purpose === 'INVITE' ? 'INVITE_ACCEPTED' : 'PASSWORD_RESET', entityType: 'User', entityId: t.userId, entityLabel: t.user.email });
}

export async function changePassword(actor: Actor, current: string, next: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) throw forbidden('Your current password is incorrect.');
  const problems = await passwordProblems(next, user.email);
  if (problems.length) throw badRequest(`Password must contain ${problems.join(', ')}.`);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() } });
  await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: actor.sessionId } }, data: { revokedAt: new Date() } });
  await audit(prisma, actor, { action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id, entityLabel: user.email });
}
