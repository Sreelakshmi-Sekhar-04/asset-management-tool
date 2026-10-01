import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * File storage abstraction. The default driver writes to STORAGE_DIR on local disk
 * (mount a persistent volume in production). Swap for S3/Azure by implementing the same functions.
 */
const ROOT = path.resolve(process.env.STORAGE_DIR ?? './storage');

function safePath(key: string) {
  const p = path.resolve(ROOT, key);
  if (!p.startsWith(ROOT + path.sep)) throw new Error('Invalid storage key');
  return p;
}

export function newKey(prefix: string, ext = '') {
  const d = new Date();
  return `${prefix}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}${ext}`;
}

export async function putObject(key: string, data: Buffer) {
  const p = safePath(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data, { mode: 0o600 });
}

export async function getObject(key: string): Promise<Buffer> {
  return fs.readFile(safePath(key));
}

export async function deleteObject(key: string) {
  await fs.rm(safePath(key), { force: true });
}
