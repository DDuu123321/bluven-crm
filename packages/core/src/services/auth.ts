import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { Db, Role } from '@bluven/db';
import { inTx, type Ctx, type UserActor } from '../context';
import { normalizeEmail } from '../domain';
import { FieldErrors, ForbiddenError, ValidationError } from '../errors';
import { newId } from '../ids';
import { audit } from './audit';

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 64, maxmem: 96 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns "scrypt$N$r$p$salt$hash" with base64url parts. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 2 ** 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  const actual = await scrypt(password, salt, N, r, p, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash to burn time against when the account does not exist, so timing does not reveal that. */
let dummyHash: Promise<string> | undefined;

export const PASSWORD_MIN_LENGTH = 10;

export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > 200) return 'Use at most 200 characters.';
  if (new Set(password).size < 4) return 'Use a less repetitive password.';
  if (email && password.toLowerCase() === email.toLowerCase()) return 'Do not use your email address as your password.';
  return null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_BELOW_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
const MAX_FAILED_BEFORE_LOCK = 5;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionUser extends Omit<UserActor, 'kind'> {
  mustChangePassword: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}

const BAD_CREDENTIALS = 'Incorrect email or password.';

/** Verifies the credentials and opens a session. Returns the opaque session token for the cookie. */
export async function login(db: Db, input: LoginInput): Promise<{ token: string; expiresAt: Date; user: SessionUser }> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  const user = email ? await db.user.findUnique({ where: { email } }) : null;
  const ctx: Ctx = { db, actor: { kind: 'system', label: `login:${email ?? 'invalid'}` }, ip: input.ip, userAgent: input.userAgent, now: () => now };

  if (!user || !user.isActive) {
    dummyHash ??= hashPassword('not-a-real-password');
    await verifyPassword(input.password, await dummyHash);
    throw new ValidationError(BAD_CREDENTIALS);
  }
  if (user.lockedUntil && user.lockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000));
    throw new ValidationError(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    const failed = user.failedLoginCount + 1;
    const lockMinutes = failed >= MAX_FAILED_BEFORE_LOCK ? Math.min(15, 2 ** (failed - MAX_FAILED_BEFORE_LOCK)) : 0;
    await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: failed, lockedUntil: lockMinutes ? new Date(now.getTime() + lockMinutes * 60_000) : null },
    });
    await audit(db, ctx, {
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: user.id,
      summary: `Failed sign-in for ${user.email}`,
      meta: { failedLoginCount: failed, lockedForMinutes: lockMinutes },
    });
    throw new ValidationError(BAD_CREDENTIALS);
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } }),
    db.session.create({
      data: {
        id: newId('ses'),
        tokenHash: hashToken(token),
        userId: user.id,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    }),
  ]);
  await audit(db, { ...ctx, actor: { kind: 'user', id: user.id, name: user.name, email: user.email, roles: user.roles } }, {
    action: 'auth.login',
    entityType: 'User',
    entityId: user.id,
    summary: `${user.name} signed in`,
  });
  return {
    token,
    expiresAt,
    user: { id: user.id, name: user.name, email: user.email, roles: user.roles, mustChangePassword: user.mustChangePassword },
  };
}

/** Resolves a session token to its user. Extends the session when it is more than half used. */
export async function getSessionUser(db: Db, token: string | undefined | null, now: Date = new Date()): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.expiresAt <= now || !session.user.isActive) return null;

  const remaining = session.expiresAt.getTime() - now.getTime();
  const sinceSeen = now.getTime() - session.lastSeenAt.getTime();
  if (remaining < SESSION_RENEW_BELOW_MS || sinceSeen > LAST_SEEN_THROTTLE_MS) {
    await db.session
      .update({
        where: { id: session.id },
        data: {
          lastSeenAt: now,
          expiresAt: remaining < SESSION_RENEW_BELOW_MS ? new Date(now.getTime() + SESSION_TTL_MS) : undefined,
        },
      })
      .catch(() => undefined); // a concurrent sign-out may have removed the row
  }
  const u = session.user;
  return { id: u.id, name: u.name, email: u.email, roles: u.roles, mustChangePassword: u.mustChangePassword };
}

export async function logout(db: Db, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Removes expired sessions. Called by the worker. */
export async function purgeExpiredSessions(db: Db, now: Date = new Date()): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}

export async function changeOwnPassword(ctx: Ctx, input: { current: string; next: string; keepToken?: string | null }): Promise<void> {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  const actor = ctx.actor;
  const user = await ctx.db.user.findUnique({ where: { id: actor.id } });
  if (!user) throw new ForbiddenError();
  const errors = new FieldErrors();
  if (!(await verifyPassword(input.current, user.passwordHash))) errors.add('current', 'Your current password is not correct.');
  const problem = passwordProblem(input.next, user.email);
  if (problem) errors.add('next', problem);
  else if (input.next === input.current) errors.add('next', 'Choose a password you have not just used.');
  errors.throwIfAny();

  const passwordHash = await hashPassword(input.next);
  const keepHash = input.keepToken ? hashToken(input.keepToken) : null;
  await inTx(ctx.db, async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
    // Sign out everywhere else.
    await tx.session.deleteMany({ where: { userId: user.id, ...(keepHash ? { tokenHash: { not: keepHash } } : {}) } });
    await audit(tx, ctx, { action: 'auth.password_change', entityType: 'User', entityId: user.id, summary: `${user.name} changed their password` });
  });
}

// ---------------------------------------------------------------------------
// User administration
// ---------------------------------------------------------------------------

const ALL_ROLES: Role[] = ['SALES', 'MANAGER', 'FINANCE', 'OPS', 'ADMIN'];

function requireAdmin(ctx: Ctx): UserActor {
  if (ctx.actor.kind !== 'user' || !ctx.actor.roles.includes('ADMIN')) throw new ForbiddenError();
  return ctx.actor;
}

function cleanRoles(roles: readonly string[], errors: FieldErrors): Role[] {
  const out = [...new Set(roles)].filter((r): r is Role => (ALL_ROLES as string[]).includes(r));
  if (out.length === 0) errors.add('roles', 'Choose at least one role.');
  return out;
}

export interface CreateUserInput {
  email: string;
  name: string;
  roles: string[];
  password: string;
}

export async function createUser(ctx: Ctx, input: CreateUserInput): Promise<{ id: string }> {
  requireAdmin(ctx);
  const errors = new FieldErrors();
  const email = normalizeEmail(input.email);
  if (!email) errors.add('email', 'Enter a valid email address.');
  const name = input.name.trim();
  if (!name) errors.add('name', 'Enter the person’s name.');
  if (name.length > 100) errors.add('name', 'Use at most 100 characters.');
  const roles = cleanRoles(input.roles, errors);
  const problem = passwordProblem(input.password, email ?? undefined);
  if (problem) errors.add('password', problem);
  if (email && (await ctx.db.user.findUnique({ where: { email } }))) errors.add('email', 'A user with this email already exists.');
  errors.throwIfAny();

  const id = newId('usr');
  const passwordHash = await hashPassword(input.password);
  await inTx(ctx.db, async (tx) => {
    await tx.user.create({ data: { id, email: email!, name, roles, passwordHash, mustChangePassword: true } });
    await audit(tx, ctx, {
      action: 'user.create',
      entityType: 'User',
      entityId: id,
      summary: `Created user ${name} (${email})`,
      after: { email, name, roles, isActive: true },
    });
  });
  return { id };
}

export interface UpdateUserInput {
  userId: string;
  name: string;
  roles: string[];
  isActive: boolean;
}

export async function updateUser(ctx: Ctx, input: UpdateUserInput): Promise<void> {
  const admin = requireAdmin(ctx);
  const errors = new FieldErrors();
  const name = input.name.trim();
  if (!name) errors.add('name', 'Enter the person’s name.');
  const roles = cleanRoles(input.roles, errors);
  errors.throwIfAny();

  await inTx(ctx.db, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new ValidationError('User not found.');
    const losesAdmin = user.roles.includes('ADMIN') && (!roles.includes('ADMIN') || !input.isActive);
    if (losesAdmin) {
      const otherAdmins = await tx.user.count({ where: { isActive: true, roles: { has: 'ADMIN' }, id: { not: user.id } } });
      if (otherAdmins === 0) throw new ValidationError('At least one active admin is required.', { roles: 'This is the last active admin.' });
    }
    if (user.id === admin.id && !input.isActive) throw new ValidationError('You cannot deactivate your own account.');

    await tx.user.update({ where: { id: user.id }, data: { name, roles, isActive: input.isActive } });
    if (!input.isActive) await tx.session.deleteMany({ where: { userId: user.id } });
    await audit(tx, ctx, {
      action: 'user.update',
      entityType: 'User',
      entityId: user.id,
      summary: `Updated user ${user.email}`,
      before: { name: user.name, roles: user.roles, isActive: user.isActive },
      after: { name, roles, isActive: input.isActive },
    });
  });
}

/** Sets a temporary password. The user must choose a new one at next sign-in; open sessions end. */
export async function resetUserPassword(ctx: Ctx, input: { userId: string; password: string }): Promise<void> {
  requireAdmin(ctx);
  const user = await ctx.db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new ValidationError('User not found.');
  const problem = passwordProblem(input.password, user.email);
  if (problem) throw new ValidationError(problem, { password: problem });
  const passwordHash = await hashPassword(input.password);
  await inTx(ctx.db, async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await audit(tx, ctx, { action: 'user.password_reset', entityType: 'User', entityId: user.id, summary: `Reset password for ${user.email}` });
  });
}

/** Creates the first admin if no user exists yet. Used by the seed script. */
export async function ensureFirstAdmin(db: Db, input: { email: string; name: string; password: string }): Promise<'created' | 'exists'> {
  if ((await db.user.count()) > 0) return 'exists';
  const email = normalizeEmail(input.email);
  if (!email) throw new Error('SEED_ADMIN_EMAIL is not a valid email address');
  const problem = passwordProblem(input.password, email);
  if (problem) throw new Error(`SEED_ADMIN_PASSWORD: ${problem}`);
  const id = newId('usr');
  await db.user.create({
    data: { id, email, name: input.name.trim() || 'Admin', roles: ['ADMIN', 'MANAGER'], passwordHash: await hashPassword(input.password), mustChangePassword: true },
  });
  await audit(db, { db, actor: { kind: 'system', label: 'Seed' } }, {
    action: 'user.create',
    entityType: 'User',
    entityId: id,
    summary: `Created first admin ${email}`,
    after: { email, roles: ['ADMIN', 'MANAGER'] },
  });
  return 'created';
}

