import nodemailer, { type Transporter } from 'nodemailer';
import { prisma } from '@/lib/db';

let transport: Transporter | null = null;

/** SMTP transport from SMTP_URL, or null when it is not configured. */
export function smtpTransport(): Transporter | null {
  const url = process.env.SMTP_URL?.trim();
  if (!url) return null;
  transport ??= nodemailer.createTransport(url);
  return transport;
}

export const mailFrom = () => process.env.MAIL_FROM || 'IT Assets <no-reply@localhost>';

/** SMTP_URL with the password hidden, for logs. */
export function smtpTarget() {
  const url = process.env.SMTP_URL?.trim();
  if (!url) return '(SMTP_URL not set)';
  try { const u = new URL(url); return `${u.protocol}//${u.username ? `${decodeURIComponent(u.username)}@` : ''}${u.hostname}:${u.port || (u.protocol === 'smtps:' ? 465 : 587)}`; } catch { return '(SMTP_URL is not a valid URL)'; }
}

/** Connect and authenticate once, so a wrong host or password shows in the worker log at start. */
export async function verifySmtp(): Promise<{ ok: boolean; message: string }> {
  const t = smtpTransport();
  if (!t) return { ok: false, message: 'SMTP_URL is not set: emails are queued and marked failed, nothing is sent.' };
  try {
    await t.verify();
    return { ok: true, message: `SMTP ready: ${smtpTarget()}, sending as ${mailFrom()}` };
  } catch (e) {
    return { ok: false, message: `SMTP check failed for ${smtpTarget()}: ${(e as Error).message}` };
  }
}

const MAX_ATTEMPTS = 5;
const NOT_CONFIGURED = 'Not sent: SMTP_URL is not configured on the server';

/**
 * Send due messages from the outbox with exponential backoff. A message is marked SENT only when
 * the mail server accepted it; every failure keeps the server's error on the message and in the
 * worker log, and stays visible to Administrators (Admin → Email outbox, and on the approval request).
 * Without SMTP_URL nothing is sent: queued messages are marked FAILED with that reason, in every
 * environment, and can be retried once SMTP is configured.
 */
export async function sendPendingEmails(batch = 50) {
  const t = smtpTransport();
  if (!t) {
    const n = await prisma.emailOutbox.updateMany({ where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } }, data: { status: 'FAILED', lastError: NOT_CONFIGURED } });
    if (n.count) console.error(`[mail] SMTP_URL is not configured; ${n.count} message(s) not sent, marked failed`);
    return { sent: 0, failed: n.count };
  }
  const due = await prisma.emailOutbox.findMany({ where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: batch });
  let sent = 0, failed = 0;
  for (const m of due) {
    // Claim the row so parallel workers never double-send.
    const claimed = await prisma.emailOutbox.updateMany({ where: { id: m.id, status: 'PENDING', attempts: m.attempts }, data: { attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    try {
      const info = await t.sendMail({ from: mailFrom(), to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) });
      if (info.rejected?.length) throw new Error(`Recipient refused by the mail server: ${info.rejected.join(', ')}`);
      await prisma.emailOutbox.update({ where: { id: m.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
      console.log(`[mail] sent to=${m.to} subject="${m.subject}" id=${info.messageId ?? '—'}`);
      sent++;
    } catch (e) {
      const attempts = m.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await prisma.emailOutbox.update({ where: { id: m.id }, data: { status: final ? 'FAILED' : 'PENDING', lastError: (e as Error).message.slice(0, 500), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) } });
      console.error(`[mail] send failed to=${m.to} attempt=${attempts}${final ? ' (giving up)' : ''}: ${(e as Error).message}`);
      failed++;
    }
  }
  return { sent, failed };
}
