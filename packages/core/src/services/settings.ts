import type { DbOrTx, Prisma } from '@bluven/db';
import { actorId, inTx, type Ctx } from '../context';
import { DEFAULT_IDLE_THRESHOLDS, can, type IdleThresholds } from '../domain';
import { FieldErrors, ForbiddenError } from '../errors';
import { audit } from './audit';

export interface AppSettings {
  idle: IdleThresholds;
  /** Suggested deposit as a percentage of the quote total when the quote carries no deposit amount. */
  defaultDepositPercent: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  idle: DEFAULT_IDLE_THRESHOLDS,
  defaultDepositPercent: 10,
};

const KEY = 'app';

function sanitize(value: unknown): AppSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<AppSettings>;
  const idle = { ...DEFAULT_IDLE_THRESHOLDS, ...(v.idle ?? {}) };
  const pct = typeof v.defaultDepositPercent === 'number' ? v.defaultDepositPercent : DEFAULT_SETTINGS.defaultDepositPercent;
  return { idle, defaultDepositPercent: pct };
}

export async function getSettings(db: DbOrTx): Promise<AppSettings> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return sanitize(row?.value);
}

export async function updateSettings(ctx: Ctx, next: AppSettings): Promise<AppSettings> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'admin.settings')) throw new ForbiddenError();
  const errors = new FieldErrors();
  const { remindOwnerDays: a, remindManagerDays: b, returnToPoolDays: c } = next.idle;
  const whole = (n: number) => Number.isInteger(n) && n >= 1 && n <= 365;
  if (!whole(a)) errors.add('remindOwnerDays', 'Enter a whole number of days between 1 and 365.');
  if (!whole(b)) errors.add('remindManagerDays', 'Enter a whole number of days between 1 and 365.');
  if (!whole(c)) errors.add('returnToPoolDays', 'Enter a whole number of days between 1 and 365.');
  if (whole(a) && whole(b) && b <= a) errors.add('remindManagerDays', 'Must be later than the salesperson reminder.');
  if (whole(b) && whole(c) && c <= b) errors.add('returnToPoolDays', 'Must be later than the manager reminder.');
  if (!(next.defaultDepositPercent >= 0 && next.defaultDepositPercent <= 100)) {
    errors.add('defaultDepositPercent', 'Enter a percentage between 0 and 100.');
  }
  errors.throwIfAny();

  return inTx(ctx.db, async (tx) => {
    const before = await getSettings(tx);
    const value = next as unknown as Prisma.InputJsonValue;
    await tx.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, updatedById: actorId(ctx) },
      update: { value, updatedById: actorId(ctx) },
    });
    await audit(tx, ctx, {
      action: 'settings.update',
      entityType: 'Setting',
      entityId: KEY,
      summary: 'Updated application settings',
      before,
      after: next,
    });
    return next;
  });
}
