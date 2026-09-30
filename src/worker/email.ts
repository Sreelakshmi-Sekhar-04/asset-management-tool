import nodemailer, { type Transporter } from 'nodemailer';
import { prisma } from '@/lib/db';

let transport: Transporter | null = null;
let logOnly = false;

/**
 * SMTP when SMTP_URL is set. Without it, development logs recipient and subject only
 * (never the body) and marks the message sent; production refuses, so the outbox shows
 * FAILED with the reason instead of pretending mail went out.
 */
function getTransport() {
  if (transport) return transport;
  const url = process.env.SMTP_URL;
  if (url) {
    transport = nodemailer.createTransport(url);
  } else {
    logOnly = true;
    transport = nodemailer.createTransport({ jsonTransport: true });
  }
  return transport;
}

const MAX_ATTEMPTS = 5;

/** Send due messages from the outbox with exponential backoff; failures stay visible to Administrators. */
export async function sendPendingEmails(batch = 50) {
  if (!process.env.SMTP_URL && process.env.NODE_ENV === 'production') {
    const n = await prisma.emailOutbox.updateMany({ where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } }, data: { status: 'FAILED', lastError: 'SMTP_URL is not configured on the server' } });
    if (n.count) console.error(`[mail] SMTP_URL is not configured; ${n.count} message(s) marked failed`);
    return { sent: 0, failed: n.count };
  }
  const t = getTransport();
  const due = await prisma.emailOutbox.findMany({ where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: batch });
  let sent = 0, failed = 0;
  for (const m of due) {
    // Claim the row so parallel workers never double-send.
    const claimed = await prisma.emailOutbox.updateMany({ where: { id: m.id, status: 'PENDING', attempts: m.attempts }, data: { attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    try {
      await t.sendMail({ from: process.env.MAIL_FROM || 'IT Assets <no-reply@localhost>', to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) });
      await prisma.emailOutbox.update({ where: { id: m.id }, data: { status: 'SENT', sentAt: new Date(), lastError: logOnly ? 'SMTP not configured: logged only' : null } });
      if (logOnly) console.log(`[mail:log-only] to=${m.to} subject="${m.subject}"`);
      sent++;
    } catch (e) {
      const attempts = m.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await prisma.emailOutbox.update({ where: { id: m.id }, data: { status: final ? 'FAILED' : 'PENDING', lastError: (e as Error).message.slice(0, 500), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) } });
      console.error(`[mail] send failed to=${m.to} attempt=${attempts}: ${(e as Error).message}`);
      failed++;
    }
  }
  return { sent, failed };
}
