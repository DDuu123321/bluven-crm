// Document retention: when an order counts as ended, and what is due for an order whose documents
// are near the end of their retention period. Pure functions, safe for browser code.
import type { OrderStage, SideState } from './stages';

export interface RetentionSettings {
  /** Years a document is kept after its order ended, unless its document type sets a period of its own. */
  years: number;
  /** How many days before the end of the period the salesperson and the managers are reminded. */
  reminderDays: number;
  /** Delete at the end of the period when nobody has decided. Off: nothing is deleted unless a person chooses to. */
  autoDelete: boolean;
}

export const DEFAULT_RETENTION: RetentionSettings = { years: 2, reminderDays: 30, autoDelete: false };

/** Days between a document being deleted and its file leaving storage. */
export const PURGE_AFTER_DAYS = 30;

/** Managers are reminded again this often about an order that is past its retention period and undecided. */
export const RETENTION_NUDGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrderEndFacts {
  stage: OrderStage;
  sideState: SideState;
  lostAt: Date | null;
  cancelledAt: Date | null;
  handedOverAt: Date | null;
}

/**
 * The day an order ended: lost, cancelled, or accepted by operations. Null while the order is
 * still open, and then nothing of it expires. A lost order that is restored is open again.
 */
export function orderEndedAt(o: OrderEndFacts): Date | null {
  if (o.sideState === 'LOST') return o.lostAt;
  if (o.sideState === 'CANCELLED') return o.cancelledAt;
  if (o.stage === 'HANDED_OVER') return o.handedOverAt;
  return null;
}

/** The same day and time a number of calendar years later. 29 February lands on 28 February. */
export function addYears(date: Date, years: number): Date {
  const out = new Date(date.getTime());
  const month = out.getUTCMonth();
  out.setUTCFullYear(out.getUTCFullYear() + years);
  if (out.getUTCMonth() !== month) out.setUTCDate(0);
  return out;
}

/** The moment up to which the end of a retention period is close enough to remind people about. */
export function retentionHorizon(now: Date, s: RetentionSettings): Date {
  return new Date(now.getTime() + s.reminderDays * DAY_MS);
}

export type RetentionStep = 'REMIND' | 'DELETE' | 'NUDGE';

export interface RetentionProgress {
  /** The earliest end of a retention period among the order's documents. Null when it has none under retention. */
  deadline: Date | null;
  /** The deadline the last reminder was about, and when it went out. */
  remindedFor: Date | null;
  remindedAt: Date | null;
  /** When the managers were last reminded again. */
  nudgedAt: Date | null;
}

/** Whether the people concerned have been told about this particular end date. */
function remindedAbout(o: RetentionProgress): o is RetentionProgress & { deadline: Date; remindedAt: Date } {
  return !!o.deadline && !!o.remindedFor && !!o.remindedAt && o.remindedFor.getTime() === o.deadline.getTime();
}

/**
 * What the retention job owes an order right now, or null when nothing is due.
 *  - REMIND: the period ends within the reminder window and nobody has been told about this end date.
 *  - DELETE: the period has ended, nobody decided, automatic deletion is on, and the reminder is at
 *    least a full lead time old. Nothing is ever deleted before people have had that long.
 *  - NUDGE: the period has ended, nobody decided, automatic deletion is off: tell the managers
 *    again, at most once a week.
 */
export function nextRetentionStep(o: RetentionProgress, s: RetentionSettings, now: Date): RetentionStep | null {
  if (!o.deadline) return null;
  if (o.deadline.getTime() > retentionHorizon(now, s).getTime()) return null;
  if (!remindedAbout(o)) return 'REMIND';
  if (o.deadline.getTime() > now.getTime()) return null;
  if (s.autoDelete) return now.getTime() >= o.remindedAt.getTime() + s.reminderDays * DAY_MS ? 'DELETE' : null;
  const last = o.nudgedAt && o.nudgedAt.getTime() > o.remindedAt.getTime() ? o.nudgedAt : o.remindedAt;
  return now.getTime() - last.getTime() >= RETENTION_NUDGE_DAYS * DAY_MS ? 'NUDGE' : null;
}

/**
 * When automatic deletion would happen for an order: at the end of the period, but never sooner
 * than a full lead time after the reminder (or after now, while no reminder has gone out yet).
 * Null when automatic deletion is off.
 */
export function autoDeleteMoment(o: RetentionProgress, s: RetentionSettings, now: Date): Date | null {
  if (!s.autoDelete || !o.deadline) return null;
  const reminded = remindedAbout(o) ? o.remindedAt : now;
  return new Date(Math.max(o.deadline.getTime(), reminded.getTime() + s.reminderDays * DAY_MS));
}
