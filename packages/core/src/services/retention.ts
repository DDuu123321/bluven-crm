// Document retention. Documents are kept for a number of years counted from the day their order
// ended (completed, lost or cancelled). An order that is still open has no end, and nothing of
// it expires. Shortly before the end of the period the salesperson and the managers are asked to
// choose: keep for another year, or delete. Deleting is a soft delete; the file leaves storage 30
// days later. Contract and deposit files, and every document type an admin has marked "never
// delete automatically", are outside all of this.
import { Prisma, type DbOrTx, type Tx } from '@bluven/db';
import { actorId, inTx, nowOf, type Ctx } from '../context';
import { getConfig } from '../config';
import {
  PURGE_AFTER_DAYS,
  addYears,
  autoDeleteMoment,
  can,
  formatDate,
  fullName,
  nextRetentionStep,
  orderEndedAt,
  retentionHorizon,
  type RetentionSettings,
} from '../domain';
import { ConflictError, ForbiddenError } from '../errors';
import { getStorage } from '../storage';
import { addActivity } from './activity';
import { audit } from './audit';
import { managerIds, notifyUsers } from './notify';
import { lockOrder, lockOrderForStaff, requireOrderView } from './orders';
import { DOC_TYPE } from './reference';
import { getSettings } from './settings';

const DAY_MS = 86_400_000;

/** Never under retention, whatever their type's settings say: the record of what was signed and paid. */
const EXEMPT_TYPE_KEYS = [DOC_TYPE.signedContract, DOC_TYPE.depositProof];

/** A moment as a query parameter the database reads the same way whatever its session time zone is. */
const at = (date: Date): Prisma.Sql => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** When the order "o" ended, NULL while it is open. The SQL form of orderEndedAt(). */
const ENDED = Prisma.sql`(CASE WHEN o."sideState" = 'LOST' THEN o."lostAt" WHEN o."sideState" = 'CANCELLED' THEN o."cancelledAt" WHEN o."stage" = 'COMPLETED' THEN o."completedAt" END)`;

/** The document "d" of type "t" is one that retention applies to. */
const UNDER_RETENTION = Prisma.sql`d."deletedAt" IS NULL AND NOT t."neverAutoDelete" AND t."key" NOT IN (${Prisma.join(EXEMPT_TYPE_KEYS)})`;

/**
 * The end of a document's retention period: the order's end plus the period of the document's
 * type (its own, or the standard one from the settings), and never before a date the order's
 * documents were kept until. This expression is the one place the rule is written down; lists,
 * counts, the job and the decisions all read deadlines through it.
 */
function deadlineSql(s: RetentionSettings): Prisma.Sql {
  return Prisma.sql`GREATEST(${ENDED} + make_interval(years => COALESCE(t."retentionYears", ${s.years}::int)), o."retentionKeepUntil")`;
}

/** A document under retention, with the end of its own period. */
export interface RetainedDocument {
  id: string;
  fileName: string;
  typeKey: string;
  typeLabel: string;
  sizeBytes: number;
  sha256: string;
  deadline: Date;
}

/** Every document of one order that is under retention, soonest to expire first. Empty while the order is open. */
async function retainedDocuments(db: DbOrTx, s: RetentionSettings, orderId: string): Promise<RetainedDocument[]> {
  return db.$queryRaw<RetainedDocument[]>(Prisma.sql`
    SELECT d."id", d."fileName", d."sizeBytes", d."sha256", t."key" AS "typeKey", t."label" AS "typeLabel", ${deadlineSql(s)} AS "deadline"
    FROM "Order" o
    JOIN "Document" d ON d."orderId" = o."id"
    JOIN "DocumentType" t ON t."id" = d."typeId"
    WHERE o."id" = ${orderId} AND ${ENDED} IS NOT NULL AND ${UNDER_RETENTION}
    ORDER BY "deadline", d."createdAt", d."id"`);
}

interface RetentionView {
  docs: RetainedDocument[];
  /** The earliest end of a period among them. */
  deadline: Date | null;
  /** Those whose period has ended or ends within the reminder window. */
  expiring: RetainedDocument[];
}

async function retentionOf(db: DbOrTx, s: RetentionSettings, now: Date, orderId: string): Promise<RetentionView> {
  const docs = await retainedDocuments(db, s, orderId);
  const horizon = retentionHorizon(now, s).getTime();
  return { docs, deadline: docs[0]?.deadline ?? null, expiring: docs.filter((d) => d.deadline.getTime() <= horizon) };
}

interface AwaitingRow {
  id: string;
  deadline: Date;
  documents: number;
  sizeBytes: number;
}

/**
 * Orders with at least one document whose period has ended or ends within the reminder window:
 * the orders that are waiting for a decision. One row per order with its earliest deadline.
 */
function awaitingSql(s: RetentionSettings, now: Date): Prisma.Sql {
  const horizon = at(retentionHorizon(now, s));
  // No document can be due before its order has been closed for the shortest period any type has,
  // so most orders are ruled out before a single document is looked at.
  const shortest = Prisma.sql`LEAST(${s.years}::int, COALESCE((SELECT MIN(st."retentionYears") FROM "DocumentType" st WHERE st."retentionYears" IS NOT NULL), ${s.years}::int))`;
  return Prisma.sql`
    SELECT d."orderId" AS "id", MIN(x."deadline") AS "deadline", COUNT(*)::int AS "documents", SUM(d."sizeBytes")::float8 AS "sizeBytes"
    FROM "Order" o
    JOIN "Document" d ON d."orderId" = o."id"
    JOIN "DocumentType" t ON t."id" = d."typeId"
    CROSS JOIN LATERAL (SELECT ${deadlineSql(s)} AS "deadline") x
    WHERE ${ENDED} IS NOT NULL
      AND ${ENDED} + make_interval(years => ${shortest}) <= ${horizon}
      AND (o."retentionKeepUntil" IS NULL OR o."retentionKeepUntil" <= ${horizon})
      AND ${UNDER_RETENTION}
      AND x."deadline" <= ${horizon}
    GROUP BY d."orderId"`;
}

// ---------------------------------------------------------------------------
// What the pages show
// ---------------------------------------------------------------------------

export interface OrderRetention {
  /**
   * OPEN: the order has not ended, so nothing expires. NONE: it has ended but holds no document
   * under retention. KEPT: the next period ends later than the reminder window. DUE: it ends
   * within the window. PAST: it has ended and nobody has decided.
   */
  status: 'OPEN' | 'NONE' | 'KEPT' | 'DUE' | 'PAST';
  endedAt: Date | null;
  /** The earliest end of a retention period among the order's documents. */
  deadline: Date | null;
  /** The documents a decision made now would apply to. */
  expiring: RetainedDocument[];
  /** How many of the order's documents are under retention at all. */
  retained: number;
  /** When the expiring documents would be deleted automatically; null when that is switched off. */
  autoDeleteAt: Date | null;
  reminderDays: number;
}

/**
 * Where an order stands with the retention of its documents, for the salesperson and managers.
 * Null for operations and finance, who take no part in it.
 */
export async function getOrderRetention(ctx: Ctx, orderId: string): Promise<OrderRetention | null> {
  const { view } = await requireOrderView(ctx.db, ctx, orderId);
  if (view !== 'FULL') return null;
  const s = (await getSettings(ctx.db)).retention;
  const now = nowOf(ctx);
  const order = await ctx.db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { stage: true, sideState: true, lostAt: true, cancelledAt: true, completedAt: true, retentionRemindedFor: true, retentionRemindedAt: true, retentionNudgedAt: true },
  });
  const endedAt = orderEndedAt(order);
  const base = { endedAt, reminderDays: s.reminderDays };
  if (!endedAt) return { ...base, status: 'OPEN', deadline: null, expiring: [], retained: 0, autoDeleteAt: null };
  const { docs, deadline, expiring } = await retentionOf(ctx.db, s, now, orderId);
  if (!deadline) return { ...base, status: 'NONE', deadline: null, expiring: [], retained: 0, autoDeleteAt: null };
  const status = expiring.length === 0 ? 'KEPT' : deadline.getTime() <= now.getTime() ? 'PAST' : 'DUE';
  const progress = { deadline, remindedFor: order.retentionRemindedFor, remindedAt: order.retentionRemindedAt, nudgedAt: order.retentionNudgedAt };
  return { ...base, status, deadline, expiring, retained: docs.length, autoDeleteAt: status === 'KEPT' ? null : autoDeleteMoment(progress, s, now) };
}

export interface RetentionOrderRow {
  id: string;
  orderNo: string;
  customerName: string;
  ownerName: string | null;
  /** How the order ended. */
  ended: 'LOST' | 'CANCELLED' | 'COMPLETED';
  endedAt: Date;
  /** The earliest end of a retention period among its documents. */
  deadline: Date;
  /** The period has ended; otherwise it ends within the reminder window. */
  past: boolean;
  /** Documents a decision would apply to, and their size together. */
  documents: number;
  sizeBytes: number;
  autoDeleteAt: Date | null;
}

const LIST_LIMIT = 300;

/** Orders waiting for a retention decision, most urgent first. For managers. */
export async function listRetentionOrders(ctx: Ctx): Promise<{ rows: RetentionOrderRow[]; total: number; settings: RetentionSettings }> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'orders.assign')) throw new ForbiddenError();
  const settings = (await getSettings(ctx.db)).retention;
  const now = nowOf(ctx);
  const awaiting = await ctx.db.$queryRaw<AwaitingRow[]>(Prisma.sql`${awaitingSql(settings, now)} ORDER BY 2, 1`);
  const shown = awaiting.slice(0, LIST_LIMIT);
  const orders = await ctx.db.order.findMany({
    where: { id: { in: shown.map((a) => a.id) } },
    select: {
      id: true,
      orderNo: true,
      stage: true,
      sideState: true,
      lostAt: true,
      cancelledAt: true,
      completedAt: true,
      retentionRemindedFor: true,
      retentionRemindedAt: true,
      retentionNudgedAt: true,
      customer: { select: { firstName: true, lastName: true } },
      owner: { select: { name: true } },
    },
  });
  const byId = new Map(orders.map((o) => [o.id, o]));
  const rows: RetentionOrderRow[] = [];
  for (const a of shown) {
    const o = byId.get(a.id);
    const endedAt = o ? orderEndedAt(o) : null;
    if (!o || !endedAt) continue; // reopened since the query ran
    rows.push({
      id: o.id,
      orderNo: o.orderNo,
      customerName: fullName(o.customer),
      ownerName: o.owner?.name ?? null,
      ended: o.sideState === 'LOST' ? 'LOST' : o.sideState === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED',
      endedAt,
      deadline: a.deadline,
      past: a.deadline.getTime() <= now.getTime(),
      documents: a.documents,
      sizeBytes: a.sizeBytes,
      autoDeleteAt: autoDeleteMoment({ deadline: a.deadline, remindedFor: o.retentionRemindedFor, remindedAt: o.retentionRemindedAt, nudgedAt: o.retentionNudgedAt }, settings, now),
    });
  }
  return { rows, total: awaiting.length, settings };
}

/** How many orders are waiting for a retention decision. For the navigation badge. */
export async function retentionAwaitingCount(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const s = (await getSettings(db)).retention;
  const rows = await db.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS "n" FROM (${awaitingSql(s, now)}) q`);
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const NOTHING_DUE = 'None of this order’s documents is close to the end of its retention period.';

const count = (n: number): string => `${n} document${n === 1 ? '' : 's'}`;

/**
 * Soft-deletes documents at the end of their retention period, each with its own audit entry.
 * The rule that protects the file of a quote that was sent applies while an order is being
 * worked on; at the end of retention such a file goes like any other. Contract and deposit files
 * never reach this function.
 */
async function deleteForRetention(tx: Tx, ctx: Ctx, order: { id: string; orderNo: string; customerId: string }, docs: RetainedDocument[], how: 'decision' | 'automatic'): Promise<void> {
  const now = nowOf(ctx);
  for (const d of docs) {
    await tx.document.update({ where: { id: d.id }, data: { deletedAt: now, deletedById: actorId(ctx) } });
    await audit(tx, ctx, {
      action: 'document.delete',
      entityType: 'Document',
      entityId: d.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: deleted ${d.typeLabel} “${d.fileName}” at the end of its retention period${how === 'automatic' ? ' (automatically, nobody had decided)' : ''}`,
      before: { type: d.typeKey, fileName: d.fileName, sha256: d.sha256, sizeBytes: d.sizeBytes },
      meta: { retention: how, periodEnded: d.deadline },
    });
  }
  await addActivity(tx, ctx, {
    customerId: order.customerId,
    orderId: order.id,
    type: 'DOCUMENT',
    summary: `Deleted ${count(docs.length)} at the end of ${docs.length === 1 ? 'its' : 'their'} retention period${how === 'automatic' ? ' (automatically, nobody had decided)' : ''}`,
    body: docs.map((d) => `${d.typeLabel}: ${d.fileName}`).join('\n'),
    payload: { retention: how, documentIds: docs.map((d) => d.id) },
  });
}

/**
 * "Keep for another year": the order's expiring documents stay for a year beyond the end of their
 * period, or a year from today when that end has already passed. The salesperson of the order or
 * a manager decides.
 */
export async function keepDocumentsAnotherYear(ctx: Ctx, input: { orderId: string }): Promise<{ keptUntil: Date; documents: number }> {
  return inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    const s = (await getSettings(tx)).retention;
    const now = nowOf(ctx);
    const { expiring } = await retentionOf(tx, s, now, order.id);
    if (expiring.length === 0) throw new ConflictError(NOTHING_DUE);
    const latest = expiring[expiring.length - 1]!.deadline;
    const keptUntil = addYears(latest.getTime() > now.getTime() ? latest : now, 1);
    const before = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { retentionKeepUntil: true } });
    await tx.order.update({ where: { id: order.id }, data: { retentionKeepUntil: keptUntil, retentionNudgedAt: null } });
    const until = formatDate(keptUntil, getConfig().timeZone);
    await addActivity(tx, ctx, {
      customerId: order.customerId,
      orderId: order.id,
      type: 'DOCUMENT',
      summary: `Kept ${count(expiring.length)} for another year, until ${until}`,
      payload: { retention: 'extended', keptUntil, documentIds: expiring.map((d) => d.id) },
    });
    await audit(tx, ctx, {
      action: 'retention.extend',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: kept ${count(expiring.length)} for another year, until ${until}`,
      before: { retentionKeepUntil: before.retentionKeepUntil, periodEnded: expiring[0]!.deadline },
      after: { retentionKeepUntil: keptUntil },
      meta: { documents: expiring.map((d) => ({ id: d.id, type: d.typeKey, fileName: d.fileName })) },
    });
    return { keptUntil, documents: expiring.length };
  });
}

/** "Delete now": soft-deletes the order's expiring documents. The salesperson of the order or a manager decides. */
export async function deleteExpiringDocuments(ctx: Ctx, input: { orderId: string }): Promise<{ deleted: number }> {
  return inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    const s = (await getSettings(tx)).retention;
    const { expiring } = await retentionOf(tx, s, nowOf(ctx), order.id);
    if (expiring.length === 0) throw new ConflictError(NOTHING_DUE);
    await deleteForRetention(tx, ctx, order, expiring, 'decision');
    return { deleted: expiring.length };
  });
}

// ---------------------------------------------------------------------------
// The hourly job. Call these through runDocumentRetention, which holds the job lock.
// ---------------------------------------------------------------------------

/**
 * One order or file that cannot be dealt with must not hold up the ones after it, run after run.
 * The rest is done first; then the failure is raised so that it shows up in the worker's log.
 */
function raiseFailures(what: string, failures: unknown[]): void {
  if (failures.length === 0) return;
  throw new Error(`Document retention: ${failures.length} ${what}${failures.length === 1 ? '' : 's'} could not be processed and will be tried again`, { cause: failures[0] });
}

export interface RetentionProcessResult {
  /** Orders whose salesperson and managers were told that a period is about to end (or has ended). */
  reminders: number;
  /** Orders the managers were reminded about again because nobody has decided. */
  repeatReminders: number;
  /** Documents deleted because automatic deletion is on and nobody decided. */
  deleted: number;
}

/**
 * Who hears about the retention of an order's documents: its salesperson and the managers. Only
 * accounts that are in use count. A notification for someone who has left reaches nobody.
 */
async function retentionAudience(tx: Tx, ownerId: string | null): Promise<string[]> {
  const owner = ownerId ? await tx.user.findFirst({ where: { id: ownerId, isActive: true }, select: { id: true } }) : null;
  return [...(owner ? [owner.id] : []), ...(await managerIds(tx))];
}

/**
 * Sends each order's reminder once per retention period, reminds the managers again every week
 * about orders past their period, and, only when the setting is on, deletes what nobody decided
 * about. Safe to run as often as you like: every step is recorded on the order before the next
 * one can happen. A reminder counts only when it reached somebody, and only the documents whose
 * end date a reminder announced are ever deleted.
 */
export async function processRetention(ctx: Ctx): Promise<RetentionProcessResult> {
  const result: RetentionProcessResult = { reminders: 0, repeatReminders: 0, deleted: 0 };
  // The settings at the start of the run pick the orders to look at. What is done to each of them
  // is decided by the settings as they are when its turn comes.
  const atStart = (await getSettings(ctx.db)).retention;
  const now = nowOf(ctx);
  const tz = getConfig().timeZone;
  const awaiting = await ctx.db.$queryRaw<(AwaitingRow & { remindedFor: Date | null; remindedAt: Date | null; nudgedAt: Date | null })[]>(Prisma.sql`
    SELECT a.*, o."retentionRemindedFor" AS "remindedFor", o."retentionRemindedAt" AS "remindedAt", o."retentionNudgedAt" AS "nudgedAt"
    FROM (${awaitingSql(atStart, now)}) a JOIN "Order" o ON o."id" = a."id"
    ORDER BY a."deadline", a."id"`);

  const failures: unknown[] = [];
  for (const row of awaiting) {
    // Most orders in the list have had their reminder and are simply waiting: skip them without a transaction.
    if (!nextRetentionStep(row, atStart, now)) continue;
    await inTx(ctx.db, async (tx) => {
      await lockOrder(tx, row.id);
      // Read again under the lock: a run can take a while, and when an admin switches automatic
      // deletion off, or lengthens the period, the very next order must already follow that.
      const s = (await getSettings(tx)).retention;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: row.id },
        select: {
          id: true,
          orderNo: true,
          customerId: true,
          ownerId: true,
          stage: true,
          sideState: true,
          lostAt: true,
          cancelledAt: true,
          completedAt: true,
          retentionRemindedFor: true,
          retentionRemindedAt: true,
          retentionNudgedAt: true,
          customer: { select: { firstName: true, lastName: true } },
        },
      });
      // Decided again under the lock: somebody may have chosen in the meantime, or reopened the order.
      const { docs, deadline, expiring } = await retentionOf(tx, s, now, order.id);
      const progress = { deadline, remindedFor: order.retentionRemindedFor, remindedAt: order.retentionRemindedAt, nudgedAt: order.retentionNudgedAt };
      const step = nextRetentionStep(progress, s, now);
      const endedAt = orderEndedAt(order);
      if (!step || !deadline || !endedAt) return;

      const href = `/orders/${order.id}?tab=documents#retention`;
      const day = formatDate(deadline, tz);
      const n = expiring.length;
      const one = n === 1;
      const how = order.sideState === 'LOST' ? 'lost' : order.sideState === 'CANCELLED' ? 'cancelled' : 'completed';
      const context = `${fullName(order.customer)}, ${how} on ${formatDate(endedAt, tz)}.`;

      if (step === 'REMIND') {
        const past = deadline.getTime() <= now.getTime();
        const deleteOn = autoDeleteMoment({ ...progress, remindedFor: deadline, remindedAt: now }, s, now);
        const told = await notifyUsers(tx, ctx, await retentionAudience(tx, order.ownerId), {
          type: 'retention.reminder',
          title: past
            ? `${order.orderNo}: the retention period of ${count(n)} ended on ${day}`
            : `${order.orderNo}: ${count(n)} ${one ? 'reaches' : 'reach'} the end of ${one ? 'its' : 'their'} retention period on ${day}`,
          body: `${context} Keep ${one ? 'it' : 'them'} for another year, or delete ${one ? 'it' : 'them'}. ${
            deleteOn ? `If nobody decides, ${one ? 'it is' : 'they are'} deleted automatically on ${formatDate(deleteOn, tz)}.` : 'Nothing is deleted until someone decides.'
          }`,
          href,
          orderId: order.id,
        });
        // A reminder nobody received is no reminder. It is not recorded, so the order stays due
        // for one and nothing can be deleted on the strength of it.
        if (told === 0) return;
        await tx.order.update({ where: { id: order.id }, data: { retentionRemindedFor: deadline, retentionRemindedAt: now, retentionNudgedAt: null } });
        await audit(tx, ctx, {
          action: 'retention.reminder',
          entityType: 'Order',
          entityId: order.id,
          orderId: order.id,
          customerId: order.customerId,
          summary: `${order.orderNo}: reminded the salesperson and the managers that the retention period of ${count(n)} ${past ? 'ended' : 'ends'} on ${day}`,
          meta: { periodEnds: deadline, documents: n, settings: s },
        });
        result.reminders++;
        return;
      }

      if (step === 'NUDGE') {
        const told = await notifyUsers(tx, ctx, await managerIds(tx), {
          type: 'retention.overdue',
          title: `${order.orderNo}: ${count(n)} ${one ? 'is' : 'are'} past ${one ? 'its' : 'their'} retention period and still waiting for a decision`,
          body: `${context} The period ended on ${day}. Keep ${one ? 'it' : 'them'} for another year, or delete ${one ? 'it' : 'them'}.`,
          href,
          orderId: order.id,
        });
        if (told === 0) return;
        await tx.order.update({ where: { id: order.id }, data: { retentionNudgedAt: now } });
        await audit(tx, ctx, {
          action: 'retention.reminder',
          entityType: 'Order',
          entityId: order.id,
          orderId: order.id,
          customerId: order.customerId,
          summary: `${order.orderNo}: reminded the managers again that ${count(n)} ${one ? 'is' : 'are'} past retention and undecided`,
          meta: { periodEnded: deadline, documents: n, repeat: true },
        });
        result.repeatReminders++;
        return;
      }

      // DELETE: only the documents whose end date was announced, which is `deadline`, the date the
      // reminder was about. A document whose own period ended later gets a reminder of its own
      // first, and the full lead time after it, even when that later date has long passed too.
      const over = docs.filter((d) => d.deadline.getTime() <= deadline.getTime());
      if (over.length === 0) return;
      await deleteForRetention(tx, ctx, order, over, 'automatic');
      await notifyUsers(tx, ctx, await retentionAudience(tx, order.ownerId), {
        type: 'retention.auto_deleted',
        title: `${order.orderNo}: ${count(over.length)} ${over.length === 1 ? 'was' : 'were'} deleted automatically at the end of ${over.length === 1 ? 'its' : 'their'} retention period`,
        body: `${context} Nobody chose to keep ${over.length === 1 ? 'it' : 'them'}. The ${over.length === 1 ? 'file leaves' : 'files leave'} the server in ${PURGE_AFTER_DAYS} days.`,
        href: `/orders/${order.id}?tab=documents`,
        orderId: order.id,
      });
      result.deleted += over.length;
    }).catch((e: unknown) => {
      failures.push(e);
    });
  }
  raiseFailures('order', failures);
  return result;
}

/**
 * Removes the files of documents that were deleted at least 30 days ago, however they came to be
 * deleted. The row stays, with the time of the purge.
 *
 * A file can belong to more than one document: site photos reused on a later order at the same
 * property point at the same storage key. The bytes are removed only when no other document that
 * has not been purged itself still uses the key. A new sharer cannot appear in between, because a
 * file is only ever taken over from a document that is not deleted, and that one would be counted.
 */
export async function purgeDeletedDocuments(ctx: Ctx): Promise<{ purged: number; filesRemoved: number }> {
  const now = nowOf(ctx);
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS);
  const due = await ctx.db.document.findMany({
    where: { deletedAt: { lte: cutoff }, purgedAt: null, type: { neverAutoDelete: false, key: { notIn: EXEMPT_TYPE_KEYS } } },
    select: { id: true, orderId: true, fileName: true, storageKey: true, thumbKey: true, deletedAt: true, type: { select: { label: true } }, order: { select: { orderNo: true, customerId: true } } },
    orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  let purged = 0;
  let filesRemoved = 0;
  const failures: unknown[] = [];
  for (const doc of due) {
    await inTx(ctx.db, async (tx) => {
      const claimed = await tx.document.updateMany({ where: { id: doc.id, purgedAt: null, deletedAt: { not: null } }, data: { purgedAt: now } });
      if (claimed.count === 0) return;
      const others = await tx.document.count({ where: { storageKey: doc.storageKey, purgedAt: null, id: { not: doc.id } } });
      const thumbOthers = doc.thumbKey ? await tx.document.count({ where: { thumbKey: doc.thumbKey, purgedAt: null, id: { not: doc.id } } }) : 0;
      await audit(tx, ctx, {
        action: 'document.purge',
        entityType: 'Document',
        entityId: doc.id,
        orderId: doc.orderId,
        customerId: doc.order.customerId,
        summary:
          others === 0
            ? `${doc.order.orderNo}: removed ${doc.type.label} “${doc.fileName}” from storage, ${PURGE_AFTER_DAYS} days after it was deleted`
            : `${doc.order.orderNo}: closed the record of ${doc.type.label} “${doc.fileName}”; the file stays in storage because another order still uses it`,
        meta: { deletedAt: doc.deletedAt, fileRemoved: others === 0, stillUsedBy: others },
      });
      // Last, like the move at the end of an upload: if the file cannot be removed the transaction
      // rolls back and the next run tries again. Removing a file that is already gone is not an error.
      if (others === 0) {
        await getStorage().remove(doc.storageKey);
        filesRemoved++;
      }
      if (doc.thumbKey && thumbOthers === 0) await getStorage().remove(doc.thumbKey);
      // A file that arrived by e-mail also sits in the mail store, next to its message. That copy
      // goes with the document; the message stays, and says why its attachment cannot be opened.
      const copies = await tx.emailAttachment.findMany({ where: { documentId: doc.id, storageKey: { not: null }, message: { direction: 'IN' } }, select: { id: true, storageKey: true } });
      for (const copy of copies) {
        await tx.emailAttachment.update({ where: { id: copy.id }, data: { storageKey: null, skippedReason: 'Removed together with the document it was filed as.' } });
        await getStorage().remove(copy.storageKey!);
      }
      purged++;
    }).catch((e: unknown) => {
      failures.push(e);
    });
  }
  raiseFailures('file', failures);
  return { purged, filesRemoved };
}
