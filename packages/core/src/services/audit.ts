import type { DbOrTx, Prisma } from '@bluven/db';
import { actorId, actorLabel, nowOf, type Ctx } from '../context';
import { newId } from '../ids';

export interface AuditEntry {
  /** Dotted verb, e.g. "order.assign", "document.upload". */
  action: string;
  entityType: string;
  entityId: string;
  orderId?: string | null;
  customerId?: string | null;
  /** One human-readable line. */
  summary?: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}

/** JSON-safe copy: dates become ISO strings, undefined disappears. */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Appends one row to the audit log. Call it inside the same transaction as the change it records. */
export async function audit(db: DbOrTx, ctx: Ctx, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      id: newId('aud'),
      at: nowOf(ctx),
      actorId: actorId(ctx),
      actorLabel: actorLabel(ctx),
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      orderId: e.orderId ?? null,
      customerId: e.customerId ?? null,
      summary: e.summary ?? '',
      before: toJson(e.before),
      after: toJson(e.after),
      meta: toJson(e.meta),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 300) : null,
    },
  });
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * Compares the fields named in `next` against `prev` and returns only the ones that differ,
 * as { before, after }. Null when nothing changed.
 */
export function diff<T extends Record<string, unknown>>(
  prev: T,
  next: Partial<T>,
): { before: Partial<T>; after: Partial<T> } | null {
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  let any = false;
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (next[key] === undefined) continue;
    if (!same(prev[key], next[key])) {
      before[key] = prev[key];
      after[key] = next[key];
      any = true;
    }
  }
  return any ? { before, after } : null;
}
