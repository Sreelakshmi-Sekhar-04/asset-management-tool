import { prisma, type Db } from '@/lib/db';
import { getSettings } from './settings';

export interface NotificationInput {
  type: string;
  title: string;
  body: string;
  link?: string;
  /** Idempotency key: the same event for the same user is stored once (NFR-11). */
  eventKey: string;
  /** Override whether to email (default: per-type setting). */
  email?: boolean;
}

export async function enqueueEmail(to: string, subject: string, text: string, eventKey: string, db: Db = prisma) {
  if (!to) return;
  await db.emailOutbox.createMany({ data: [{ to: to.toLowerCase(), subject, text, eventKey }], skipDuplicates: true });
}

export async function notifyUsers(db: Db, userIds: (string | null | undefined)[], n: NotificationInput) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x && x !== 'system'))];
  if (!ids.length) return;
  const users = await db.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, email: true } });
  await db.notification.createMany({
    data: users.map((u) => ({ userId: u.id, type: n.type, title: n.title, body: n.body, link: n.link, eventKey: n.eventKey })),
    skipDuplicates: true,
  });
  const s = await getSettings(db);
  const sendEmail = n.email ?? s.notificationEmail[n.type] ?? false;
  if (sendEmail) {
    const url = n.link ? `${process.env.APP_URL ?? 'http://localhost:3000'}${n.link}` : '';
    await db.emailOutbox.createMany({
      data: users.map((u) => ({ to: u.email, subject: n.title, text: `${n.body}${url ? `\n\nOpen: ${url}` : ''}`, eventKey: n.eventKey })),
      skipDuplicates: true,
    });
  }
}

/** Active IT Operators and Administrators. */
export async function itUserIds(db: Db): Promise<string[]> {
  const rows = await db.user.findMany({ where: { active: true, role: { in: ['ADMIN', 'IT_OPERATOR'] } }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function adminUserIds(db: Db): Promise<string[]> {
  const rows = await db.user.findMany({ where: { active: true, role: 'ADMIN' }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Branch users whose scope contains the given location (their node is the location or an ancestor). */
export async function branchUserIdsFor(db: Db, locationId: string): Promise<string[]> {
  const loc = await db.location.findUnique({ where: { id: locationId }, select: { idPath: true } });
  if (!loc) return [];
  const ancestorIds = loc.idPath.split('/').filter(Boolean);
  const rows = await db.user.findMany({
    where: { active: true, role: 'BRANCH_USER', locationId: { in: ancestorIds } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
