import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDatabaseUrl } from './test-db';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), 'itam-test-'));
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'test-session-secret-not-for-production';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.BCRYPT_COST = '4';
process.env.SMTP_URL = '';
