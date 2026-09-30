import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { actorFromToken, changePassword, completePasswordReset, issueToken, login, requestPasswordReset } from '@/server/auth/session';
import { verifyPassword } from '@/server/auth/password';
import { updateUser } from '@/server/services/users';
import { PASSWORD, world, type World } from './fixtures';
import { ip, rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

describe('authentication', () => {
  it('stores only a bcrypt hash and signs in with the right password', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: w.it.user.id } });
    expect(u.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(u.passwordHash).not.toContain(PASSWORD);
    const { token } = await login(w.it.user.email, PASSWORD, { ip: ip() });
    const actor = await actorFromToken(token);
    expect(actor?.id).toBe(w.it.user.id);
    // Only the token hash is stored.
    expect(await prisma.session.count({ where: { tokenHash: token } })).toBe(0);
  });

  it('gives the same generic error for a wrong password and an unknown email', async () => {
    const a = await rejectsWith(login(w.it.user.email, 'wrong', { ip: ip() }), 401);
    const b = await rejectsWith(login(`nobody.${w.s}@test.example.com`, 'wrong', { ip: ip() }), 401);
    expect(a.message).toBe(b.message);
  });

  it('locks the account after the configured number of failures, even for the right password', async () => {
    const email = w.brC.user.email;
    for (let i = 0; i < 5; i++) await rejectsWith(login(email, 'bad-password', { ip: ip() }), 401);
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.lockedUntil && u.lockedUntil > new Date()).toBe(true);
    await rejectsWith(login(email, PASSWORD, { ip: ip() }), 401);
    expect(await prisma.auditLog.count({ where: { action: 'ACCOUNT_LOCKED', entityId: u.id } })).toBe(1);
    await prisma.user.update({ where: { email }, data: { lockedUntil: null, failedLoginCount: 0 } });
  });

  it('ends a session after the idle timeout', async () => {
    const { token } = await login(w.brA.user.email, PASSWORD, { ip: ip() });
    const s = await prisma.session.findFirstOrThrow({ where: { userId: w.brA.user.id, revokedAt: null }, orderBy: { createdAt: 'desc' } });
    await prisma.session.update({ where: { id: s.id }, data: { lastActiveAt: new Date(Date.now() - 31 * 60_000) } });
    expect(await actorFromToken(token)).toBeNull();
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).revokedAt).not.toBeNull();
  });

  it('deactivating a user terminates their sessions', async () => {
    const { token } = await login(w.brA.user.email, PASSWORD, { ip: ip() });
    expect(await actorFromToken(token)).not.toBeNull();
    await updateUser(w.admin.actor, w.brA.user.id, { active: false });
    expect(await actorFromToken(token)).toBeNull();
    await updateUser(w.admin.actor, w.brA.user.id, { active: true });
  });

  it('password reset: single use, enforces the password policy, revokes sessions', async () => {
    await requestPasswordReset(`nobody.${w.s}@test.example.com`, { ip: ip() }); // silently succeeds
    const token = await issueToken(w.it.user.id, 'RESET');
    await rejectsWith(completePasswordReset(token, 'short'), 400, /at least/);
    await completePasswordReset(token, 'N3w#Password-2026');
    await rejectsWith(completePasswordReset(token, 'An0ther#Password-2026'), 400, /invalid or has expired/);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: w.it.user.id } });
    expect(await verifyPassword('N3w#Password-2026', u.passwordHash!)).toBe(true);
    expect(await prisma.session.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
    // Put the fixture password back for other tests.
    const { token: t2 } = await login(u.email, 'N3w#Password-2026', { ip: ip() });
    const actor = (await actorFromToken(t2))!;
    await changePassword(actor, 'N3w#Password-2026', PASSWORD);
  });

  it('change password requires the current password', async () => {
    await rejectsWith(changePassword(w.admin.actor, 'not-it', 'Whatever#2026x'), 403);
  });
});
