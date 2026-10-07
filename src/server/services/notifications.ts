import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { forbidden, notFound } from '@/lib/errors';
import type { Actor } from '../actor';
import { audit } from '../audit';

// ───────────── In-app notifications (§A4.14) ─────────────

export async function listNotifications(actor: Actor, p: { unread?: boolean; skip: number; take: number }) {
  const where: Prisma.NotificationWhereInput = { userId: actor.id, ...(p.unread ? { readAt: null } : {}) };
  const [rows, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: actor.id, readAt: null } }),
  ]);
  return { rows, total, unread };
}

export async function unreadCount(actor: Actor) {
  return prisma.notification.count({ where: { userId: actor.id, readAt: null } });
}

export async function markRead(actor: Actor, ids: string[] | 'all') {
  const where: Prisma.NotificationWhereInput = { userId: actor.id, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) };
  const r = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
  return { updated: r.count };
}

/** Administrator view of outbound email, so delivery failures are visible (TC-RPT-11). */
export async function listEmailOutbox(actor: Actor, p: { status?: string; skip: number; take: number }) {
  if (actor.role !== 'ADMIN') throw forbidden();
  const where: Prisma.EmailOutboxWhereInput = p.status ? { status: p.status as 'FAILED' } : {};
  const [rows, total] = await Promise.all([
    prisma.emailOutbox.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, select: { id: true, to: true, subject: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true, nextAttemptAt: true } }),
    prisma.emailOutbox.count({ where }),
  ]);
  return { rows, total };
}

/**
 * The emails a request sent (the approvers of each step, and the receiver once approved), with
 * their real delivery state from the outbox: queued, sent (the mail server accepted it) or failed
 * with the server's error. Nothing here claims an email went out unless the send succeeded.
 */
export async function emailsForRequest(actor: Actor, requestId: string) {
  const req = await prisma.approvalRequest.findUnique({ where: { id: requestId }, include: { tasks: { select: { approverUserId: true } } } });
  const { canSeeRequest } = await import('./approvals');
  if (!req || !(await canSeeRequest(actor, req))) throw notFound('Approval request');
  return prisma.emailOutbox.findMany({
    where: { OR: [{ eventKey: { startsWith: `approval:${requestId}:` } }, { eventKey: { startsWith: `transfer:${requestId}:` } }] },
    orderBy: { createdAt: 'asc' },
    select: { id: true, to: true, subject: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true, nextAttemptAt: true },
  });
}

export async function retryEmail(actor: Actor, id: string) {
  if (actor.role !== 'ADMIN') throw forbidden();
  const e = await prisma.emailOutbox.findUnique({ where: { id } });
  if (!e) throw notFound('Email');
  await prisma.emailOutbox.update({ where: { id }, data: { status: 'PENDING', nextAttemptAt: new Date(), attempts: 0, lastError: null } });
  await audit(prisma, actor, { action: 'EMAIL_RETRY', entityType: 'Email', entityId: id, entityLabel: e.subject, details: { to: e.to } });
}

// ───────────── Saved filters (FR-RPT-03) ─────────────

export const savedFilterInput = z.object({
  page: z.string().trim().min(1).max(80).regex(/^[a-z0-9/_-]+$/i),
  name: z.string().trim().min(1, 'Name is required').max(80),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

export async function listSavedFilters(actor: Actor, page?: string) {
  return prisma.savedFilter.findMany({ where: { userId: actor.id, ...(page ? { page } : {}) }, orderBy: { name: 'asc' } });
}

export async function saveFilter(actor: Actor, input: unknown) {
  const d = savedFilterInput.parse(input);
  return prisma.savedFilter.upsert({
    where: { userId_page_name: { userId: actor.id, page: d.page, name: d.name } },
    create: { userId: actor.id, page: d.page, name: d.name, query: d.query },
    update: { query: d.query },
  });
}

export async function deleteSavedFilter(actor: Actor, id: string) {
  const f = await prisma.savedFilter.findFirst({ where: { id, userId: actor.id } });
  if (!f) throw notFound('Saved filter');
  await prisma.savedFilter.delete({ where: { id } });
}
