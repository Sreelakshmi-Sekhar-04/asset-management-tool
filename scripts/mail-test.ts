/**
 * Sends one test email straight through SMTP_URL and prints what the mail server answered.
 *
 *   npm run mail:test -- you@example.com
 *
 * Use it to check the SMTP settings before relying on approval emails: it fails loudly (exit
 * code 1, with the server's error) instead of pretending the mail went out.
 */
import { mailFrom, smtpTarget, smtpTransport, verifySmtp } from '@/worker/email';

async function main() {
  const to = process.argv.slice(2).find((a) => a.includes('@'));
  if (!to) throw new Error('Give the address to send to: npm run mail:test -- you@example.com');
  const check = await verifySmtp();
  console.log(check.message);
  if (!check.ok) throw new Error('Fix SMTP_URL (and MAIL_FROM) in .env, then run this again.');
  const info = await smtpTransport()!.sendMail({
    from: mailFrom(), to, subject: 'IT asset management: test email',
    text: `This is a test email from the IT asset management application, sent through ${smtpTarget()}.\nIf you can read it, approval emails will reach this inbox.`,
  });
  if (info.rejected?.length) throw new Error(`The mail server refused: ${info.rejected.join(', ')}`);
  console.log(`Sent to ${to}. Server response: ${info.response ?? 'accepted'} (message id ${info.messageId ?? '—'})`);
}

main().catch((e) => { console.error(`Email NOT sent: ${(e as Error).message}`); process.exitCode = 1; });
