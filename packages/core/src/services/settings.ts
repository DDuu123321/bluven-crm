import type { DbOrTx, Prisma } from '@bluven/db';
import { actorId, inTx, type Ctx } from '../context';
import { DEFAULT_IDLE_THRESHOLDS, DEFAULT_RETENTION, can, type IdleThresholds, type RetentionSettings } from '../domain';
import { FieldErrors, ForbiddenError } from '../errors';
import { audit } from './audit';

export interface AppSettings {
  idle: IdleThresholds;
  /** Suggested deposit as a percentage of the quote total when the quote carries no deposit amount. */
  defaultDepositPercent: number;
  /** How long documents are kept after their order ended, and what happens at the end. */
  retention: RetentionSettings;
}

/** What a settings form sends. A part that is left out keeps the value it has. */
export type AppSettingsInput = Omit<AppSettings, 'retention'> & { retention?: RetentionSettings };

export const DEFAULT_SETTINGS: AppSettings = {
  idle: DEFAULT_IDLE_THRESHOLDS,
  defaultDepositPercent: 10,
  retention: DEFAULT_RETENTION,
};

const KEY = 'app';

function sanitize(value: unknown): AppSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<AppSettings>;
  const idle = { ...DEFAULT_IDLE_THRESHOLDS, ...(v.idle ?? {}) };
  const pct = typeof v.defaultDepositPercent === 'number' ? v.defaultDepositPercent : DEFAULT_SETTINGS.defaultDepositPercent;
  // Settings saved before retention existed carry no such part: the defaults apply.
  const r = (typeof v.retention === 'object' && v.retention !== null ? v.retention : {}) as Partial<RetentionSettings>;
  const retention: RetentionSettings = {
    years: Number.isInteger(r.years) && r.years! >= 1 ? r.years! : DEFAULT_RETENTION.years,
    reminderDays: Number.isInteger(r.reminderDays) && r.reminderDays! >= 1 ? r.reminderDays! : DEFAULT_RETENTION.reminderDays,
    autoDelete: r.autoDelete === true,
  };
  return { idle, defaultDepositPercent: pct, retention };
}

export async function getSettings(db: DbOrTx): Promise<AppSettings> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return sanitize(row?.value);
}

export async function updateSettings(ctx: Ctx, next: AppSettingsInput): Promise<AppSettings> {
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
  if (next.retention) {
    const { years, reminderDays, autoDelete } = next.retention;
    const yearsOk = Number.isInteger(years) && years >= 1 && years <= 50;
    if (!yearsOk) errors.add('retentionYears', 'Enter a whole number of years between 1 and 50.');
    if (!whole(reminderDays)) errors.add('retentionReminderDays', 'Enter a whole number of days between 1 and 365.');
    // A reminder that would be due before the order has even ended makes no sense.
    else if (yearsOk && reminderDays >= years * 365) errors.add('retentionReminderDays', 'Must be shorter than the retention period.');
    if (typeof autoDelete !== 'boolean') errors.add('retentionAutoDelete', 'Choose whether to delete automatically.');
  }
  errors.throwIfAny();

  return inTx(ctx.db, async (tx) => {
    const before = await getSettings(tx);
    const saved: AppSettings = {
      idle: { remindOwnerDays: a, remindManagerDays: b, returnToPoolDays: c },
      defaultDepositPercent: next.defaultDepositPercent,
      retention: next.retention ? { years: next.retention.years, reminderDays: next.retention.reminderDays, autoDelete: next.retention.autoDelete } : before.retention,
    };
    const value = saved as unknown as Prisma.InputJsonValue;
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
      after: saved,
    });
    return saved;
  });
}
