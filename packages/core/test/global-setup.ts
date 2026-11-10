import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootEnv } from '@bluven/db';

/** Brings the test database up to date once before the test run. */
export default function setup(): void {
  loadRootEnv();
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set. Copy .env.example to .env first.');
  const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: dbDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
