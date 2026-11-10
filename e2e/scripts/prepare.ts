// Brings the end-to-end database to a known state: schema up to date, tables empty, reference
// data in place, one user per role, and an intake token for the Bluven website source.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureReferenceData, hashPassword, newId, rotateIntakeToken, userCtx } from '@bluven/core';
import { createDb, type Role } from '@bluven/db';
import { E2E, type E2EState } from '../env';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function ensureDatabase(): Promise<void> {
  const url = new URL(E2E.databaseUrl);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  await client.end();
}

async function main(): Promise<void> {
  await ensureDatabase();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: path.join(root, 'packages/db'), env: { ...process.env, DATABASE_URL: E2E.databaseUrl }, stdio: 'pipe' });

  const db = createDb(E2E.databaseUrl);
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  // The audit log refuses to be emptied; a test database is the one place where that is switched off.
  await db.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_no_truncate');
  try {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_no_truncate');
  }
  await ensureReferenceData(db);

  const passwordHash = await hashPassword(E2E.password);
  const people: [keyof E2EState['users'], string, Role[]][] = [
    ['admin', 'Ada Admin', ['ADMIN']],
    ['manager', 'Morgan Manager', ['MANAGER']],
    ['sam', 'Sam Sales', ['SALES']],
    ['alex', 'Alex Sales', ['SALES']],
    ['fin', 'Fay Finance', ['FINANCE']],
    ['ops', 'Olly Ops', ['OPS']],
  ];
  const users = {} as E2EState['users'];
  const ids = {} as Record<string, string>;
  for (const [key, name, roles] of people) {
    const email = `${key}@bluven.test`;
    ids[key] = newId('usr');
    await db.user.create({ data: { id: ids[key]!, email, name, roles, passwordHash, mustChangePassword: false } });
    users[key] = { email, name };
  }

  const bluven = await db.leadSource.findUniqueOrThrow({ where: { key: 'bluven-website' } });
  const admin = userCtx(db, { id: ids.admin!, name: 'Ada Admin', email: users.admin.email, roles: ['ADMIN'] });
  const { token } = await rotateIntakeToken(admin, { sourceId: bluven.id });

  rmSync(path.dirname(E2E.stateFile), { recursive: true, force: true });
  mkdirSync(E2E.storageDir, { recursive: true });
  mkdirSync(E2E.screenshotDir, { recursive: true });
  const state: E2EState = { intakeToken: token, users };
  writeFileSync(E2E.stateFile, JSON.stringify(state, null, 2));
  await db.$disconnect();
  console.log('End-to-end database is ready.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
