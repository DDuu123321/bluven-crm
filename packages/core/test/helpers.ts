import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { createDb, loadRootEnv, type Db, type Role } from '@bluven/db';
import { LocalStorage, ensureReferenceData, hashPassword, newId, setStorage, stageUpload, userCtx, type Ctx, type StagedFile } from '../src';

loadRootEnv();

let db: Db | undefined;

export function testDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    db = createDb(url);
  }
  return db;
}

/** Empties every table, restores the reference data and points storage at a fresh temp directory. */
export async function resetDb(): Promise<Db> {
  const d = testDb();
  const tables = await d.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  // The audit log refuses to be emptied; a test database is the one place where that is switched off.
  await d.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_no_truncate');
  try {
    await d.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await d.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_no_truncate');
  }
  await ensureReferenceData(d);
  setStorage(new LocalStorage(mkdtempSync(path.join(tmpdir(), 'bluven-test-'))));
  return d;
}

/** A clock tests can move. */
export class Clock {
  constructor(public current: Date = new Date('2026-11-10T01:00:00Z')) {}
  now = (): Date => this.current;
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

let userSeq = 0;
// Hashing is deliberately slow: reuse one hash for every test user.
let sharedHash: Promise<string> | undefined;

export interface TestUser {
  id: string;
  name: string;
  email: string;
  roles: Role[];
}

export async function makeUser(roles: Role[], name?: string): Promise<TestUser> {
  userSeq++;
  sharedHash ??= hashPassword('Test-password-1');
  const user = {
    id: newId('usr'),
    name: name ?? `${roles[0]!.charAt(0)}${roles[0]!.slice(1).toLowerCase()} ${userSeq}`,
    email: `user${userSeq}@bluven.test`,
    roles,
  };
  await testDb().user.create({ data: { ...user, passwordHash: await sharedHash, mustChangePassword: false } });
  return user;
}

export function as(user: TestUser, clock?: Clock): Ctx {
  return userCtx(testDb(), user, { now: clock?.now, ip: '203.0.113.7', userAgent: 'vitest' });
}

export function stream(content: string | Buffer): Readable {
  return Readable.from([typeof content === 'string' ? Buffer.from(content) : content]);
}

/** A small valid PDF-looking file with unique content. */
export function pdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
}

export async function png(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: seed % 255, g: (seed * 7) % 255, b: (seed * 13) % 255 } } })
    .png()
    .toBuffer();
}

/** A picture big enough to be a photograph rather than a logo: 300 by 300 pixels of noise that does not compress away. */
export async function photo(seed: number): Promise<Buffer> {
  const raw = Buffer.alloc(300 * 300 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + seed * 17 + ((i * i) % 251)) % 256;
  return sharp(raw, { raw: { width: 300, height: 300, channels: 3 } })
    .png()
    .toBuffer();
}

export function staged(content: Buffer, fileName: string): Promise<StagedFile> {
  return stageUpload(stream(content), fileName);
}

export async function docType(key: string) {
  return testDb().documentType.findUniqueOrThrow({ where: { key } });
}

export async function source(key: string) {
  return testDb().leadSource.findUniqueOrThrow({ where: { key } });
}

/** A lead payload with sensible defaults. */
export function lead(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalId: `ext-${Math.random().toString(36).slice(2, 10)}`,
    firstName: 'Jane',
    lastName: 'Smith',
    phone: '0412 345 678',
    email: 'jane@example.com',
    address: '12 Sample St',
    suburb: 'Parramatta',
    state: 'NSW',
    postcode: '2150',
    propertyType: 'House',
    components: ['Solar', 'Battery'],
    monthlyBill: 350,
    ...over,
  };
}
