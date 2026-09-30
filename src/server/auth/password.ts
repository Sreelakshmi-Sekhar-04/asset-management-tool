import bcrypt from 'bcryptjs';
import { getSettings } from '../settings';

const COST = Number(process.env.BCRYPT_COST ?? 12);

export const hashPassword = (pw: string) => bcrypt.hash(pw, COST);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/** Returns a list of broken rules (empty = OK). FR-CFG-09 strong password. */
export async function passwordProblems(pw: string, email?: string): Promise<string[]> {
  const s = await getSettings();
  const p: string[] = [];
  if (pw.length < s.passwordMinLength) p.push(`at least ${s.passwordMinLength} characters`);
  if (!/[a-z]/.test(pw)) p.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) p.push('an uppercase letter');
  if (!/[0-9]/.test(pw)) p.push('a digit');
  if (!/[^A-Za-z0-9]/.test(pw)) p.push('a symbol');
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase())) p.push('no part of your email address before the @');
  return p;
}

// A precomputed hash used to equalise timing when the email does not exist.
export const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7sK4rN1aZ2i3bq6Wn7a9Qx3y1lH0y0e';
