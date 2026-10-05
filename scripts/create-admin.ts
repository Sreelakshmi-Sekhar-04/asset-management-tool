/**
 * Bootstrap the first Administrator on a new installation (no demo data involved).
 *
 *   npx tsx scripts/create-admin.ts --email you@company.com --name "Your Name"
 *
 * Prompts for the password without echoing it; for automation, pipe it on stdin.
 * The password is checked against the password policy, stored only as a bcrypt hash,
 * and never printed or logged. Refuses if an active Administrator already exists —
 * add further users from Admin → Users.
 */
import { createInterface } from 'node:readline';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/server/actor';
import { createUser } from '@/server/services/users';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const tty = process.stdin.isTTY;
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!tty });
    if (tty) {
      process.stdout.write(prompt);
      // Mute echo: write nothing for each keystroke.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    }
    rl.once('line', (line) => { rl.close(); if (tty) process.stdout.write('\n'); resolve(line); });
  });
}

async function main() {
  const email = arg('email'), name = arg('name');
  if (!email || !name) throw new Error('Usage: npx tsx scripts/create-admin.ts --email <email> --name "<full name>"');
  if (await prisma.user.count({ where: { role: 'ADMIN', active: true } })) throw new Error('An active Administrator already exists. Add users from Admin → Users.');
  const password = await readPassword('Password: ');
  if (process.stdin.isTTY && (await readPassword('Repeat password: ')) !== password) throw new Error('The passwords do not match.');
  const u = await createUser({ ...SYSTEM_ACTOR, name: 'Installation bootstrap' }, { email, name, role: 'ADMIN', password, sendInvite: false });
  console.log(`Administrator ${u.email} created. Sign in at ${process.env.APP_URL ?? 'the application URL'}.`);
}

main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
