import type { Db, Tx } from '@bluven/db';
import type { Principal, Role } from './domain';
import { ForbiddenError } from './errors';

export interface UserActor extends Principal {
  kind: 'user';
  id: string;
  name: string;
  email: string;
  roles: Role[];
}

export interface SystemActor {
  kind: 'system';
  /** Shown in the timeline and the audit log, e.g. "System", "Bluven website", "Pylon". */
  label: string;
}

export type Actor = UserActor | SystemActor;

/** Everything a service needs to know about who is acting and from where. */
export interface Ctx {
  db: Db;
  actor: Actor;
  ip?: string | null;
  userAgent?: string | null;
  /** Clock override for tests. */
  now?: () => Date;
}

export function nowOf(ctx: Ctx): Date {
  return ctx.now?.() ?? new Date();
}

export function systemCtx(db: Db, label = 'System', now?: () => Date): Ctx {
  return { db, actor: { kind: 'system', label }, now };
}

export function userCtx(db: Db, user: Omit<UserActor, 'kind'>, extra: Partial<Pick<Ctx, 'ip' | 'userAgent' | 'now'>> = {}): Ctx {
  return { db, actor: { kind: 'user', ...user }, ...extra };
}

export function requireUser(ctx: Ctx): UserActor {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  return ctx.actor;
}

export function actorId(ctx: Ctx): string | null {
  return ctx.actor.kind === 'user' ? ctx.actor.id : null;
}

export function actorLabel(ctx: Ctx): string {
  return ctx.actor.kind === 'user' ? ctx.actor.name : ctx.actor.label;
}

/** Runs `fn` in a transaction with timeouts generous enough for file moves and long batches. */
export function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn, { maxWait: 15_000, timeout: 45_000 });
}
