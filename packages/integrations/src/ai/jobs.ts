// What the assistant does without being asked: briefs for orders just pushed, a look at new
// attachments, reading new bills, and fresh summaries after a customer has written.
import { Prisma, type Db } from '@bluven/db';
import { nowOf, withJobLock, type Ctx } from '@bluven/core';
import { pendingAttachments, readAttachment } from './attachments';
import { pendingBills, readBill } from './bills';
import { pendingBriefs, writeHandoffBrief } from './brief';
import { AiError, type AiModel } from './model';
import { AUTOMATIC_REQUESTS_PER_ORDER_PER_DAY, automaticAllowanceLeft, automaticRequestsByOrder, closeAbandonedRuns, dueSubjects, getAssistantSettings, servicePause, type AiKind } from './runs';
import { summariseOrder } from './summary';

export interface AssistantWork {
  briefs: number;
  attachments: number;
  bills: number;
  summaries: number;
  failed: number;
  /** Set when the day's allowance for automatic requests is used up. */
  allowanceUsedUp: boolean;
  /** Set when the service says the key or the account is wrong: nothing more is tried in this round. */
  setupProblem: string | null;
  /** Set when the service could not be reached: the round stops there and the next ones wait a few minutes. */
  serviceDown: string | null;
}

/** A customer's e-mail has to be this old before the summary is rewritten, so three e-mails in a row make one summary. */
const SETTLE_MS = 2 * 60_000;
/** No new request is started once a round has taken this long; the rest waits for the next round. */
const ROUND_BUDGET_MS = 4 * 60_000;

/**
 * Open orders on which a customer's e-mail arrived after the summary was last written, the one
 * that has waited longest first. The choice and the limit are both the database's, so that with
 * many such orders it is always the same ones that come first and none is passed over for good.
 */
export async function ordersNeedingSummary(db: Db, now: Date, limit: number): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT a."orderId" AS "id"
    FROM "Activity" a
    JOIN "Order" o ON o."id" = a."orderId"
    LEFT JOIN "OrderSummary" s ON s."orderId" = o."id"
    WHERE a."type" = 'EMAIL_IN' AND a."createdAt" >= ${new Date(now.getTime() - 3 * 86_400_000)}
      AND o."sideState" IN ('NONE', 'ON_HOLD') AND o."stage" <> 'COMPLETED'
    GROUP BY a."orderId", s."coversUntil"
    HAVING MAX(a."createdAt") <= ${new Date(now.getTime() - SETTLE_MS)} AND (s."coversUntil" IS NULL OR MAX(a."createdAt") > s."coversUntil")
    ORDER BY MAX(a."createdAt") ASC, a."orderId" ASC
    LIMIT ${limit}`);
  return rows.map((r) => r.id);
}

const LOCK_KEY = 760501;
/** How many waiting items are looked at for each one that may be done in a round: the ones that are resting after a failure are passed over, not waited behind. */
const CANDIDATES_PER_SLOT = 10;

/**
 * One round of background work. Safe to run every minute: each item is done once, an item that
 * fails waits longer each time before it is tried again without holding up the ones behind it,
 * one order cannot use up the allowance of all, and the whole round stops at the day's allowance
 * or when the service itself is in trouble. Returns null when another process is already at it.
 */
export async function runAssistantWork(ctx: Ctx, model: AiModel, limits = { briefs: 2, attachments: 4, bills: 2, summaries: 2 }): Promise<AssistantWork | null> {
  return withJobLock(ctx.db, LOCK_KEY, async () => {
    const settings = await getAssistantSettings(ctx.db);
    const result: AssistantWork = { briefs: 0, attachments: 0, bills: 0, summaries: 0, failed: 0, allowanceUsedUp: false, setupProblem: null, serviceDown: null };
    // Requests a stopped server left open are closed first, so that their items come up again.
    await closeAbandonedRuns(ctx.db, nowOf(ctx));
    // A wrong key, or a service that is down, fails every request the same way: wait for it to
    // pass rather than try each item in turn and hold the failure against it.
    const pause = await servicePause(ctx.db, nowOf(ctx));
    if (pause) {
      if (pause.reason === 'setup') result.setupProblem = pause.detail;
      else result.serviceDown = pause.detail;
      return result;
    }
    const started = Date.now();
    let allowance = await automaticAllowanceLeft(ctx.db, settings, nowOf(ctx));
    const perOrder = new Map<string, number>();
    const stopped = () => !!result.setupProblem || !!result.serviceDown || Date.now() - started > ROUND_BUDGET_MS;

    /** The first `limit` of the waiting items that may be tried now: not resting after a failure, and on an order that has not had its share for the day. */
    const choose = async <T extends { id: string; orderId: string }>(kind: AiKind, waiting: T[], limit: number): Promise<T[]> => {
      if (stopped() || waiting.length === 0) return [];
      const due = await dueSubjects(ctx.db, kind, waiting.map((item) => item.id), nowOf(ctx));
      for (const [orderId, n] of await automaticRequestsByOrder(ctx.db, waiting.map((item) => item.orderId).filter((id) => !perOrder.has(id)), nowOf(ctx))) perOrder.set(orderId, n);
      return waiting.filter((item) => due.has(item.id) && (perOrder.get(item.orderId) ?? 0) < AUTOMATIC_REQUESTS_PER_ORDER_PER_DAY).slice(0, limit);
    };

    /** Runs one item unless the round is over; counts it; never lets one item's failure stop the rest. */
    const attempt = async (kind: AiKind, item: { id: string; orderId: string }, work: () => Promise<boolean>, count: () => void): Promise<void> => {
      if (stopped()) return;
      if (allowance <= 0) {
        result.allowanceUsedUp = true;
        return;
      }
      // Two items of one order chosen together can take it to its limit between them.
      if ((perOrder.get(item.orderId) ?? 0) >= AUTOMATIC_REQUESTS_PER_ORDER_PER_DAY) return;
      const asked = () => {
        allowance--;
        perOrder.set(item.orderId, (perOrder.get(item.orderId) ?? 0) + 1);
      };
      try {
        // `work` says whether the model was actually asked; what was settled without it costs nothing.
        if (await work()) asked();
        count();
      } catch (e) {
        asked();
        result.failed++;
        // Trouble with the service is not this item's: the round ends here, and the next ones wait it out.
        if (e instanceof AiError && e.failure === 'setup') result.setupProblem = e.detail || e.message;
        else if (e instanceof AiError && e.failure === 'unavailable') result.serviceDown = e.detail || e.message;
        else if (!(e instanceof AiError)) console.error(`[assistant] ${kind} ${item.id} failed`, e);
      }
    };

    if (settings.autoBrief) {
      for (const pkg of await choose('brief', await pendingBriefs(ctx.db, nowOf(ctx), limits.briefs * CANDIDATES_PER_SLOT), limits.briefs)) {
        await attempt('brief', pkg, async () => !!(await writeHandoffBrief(ctx, { orderId: pkg.orderId }, model)), () => result.briefs++);
      }
    }
    if (settings.readAttachments) {
      for (const attachment of await choose('attachment', await pendingAttachments(ctx.db, nowOf(ctx), limits.attachments * CANDIDATES_PER_SLOT), limits.attachments)) {
        await attempt('attachment', attachment, async () => (await readAttachment(ctx, attachment.id, model)) === 'read', () => result.attachments++);
      }
    }
    if (settings.readBills) {
      for (const bill of await choose('bill', await pendingBills(ctx.db, nowOf(ctx), limits.bills * CANDIDATES_PER_SLOT), limits.bills)) {
        await attempt('bill', bill, async () => !!(await readBill(ctx, { documentId: bill.id }, model)), () => result.bills++);
      }
    }
    if (settings.autoSummary) {
      const waiting = (await ordersNeedingSummary(ctx.db, nowOf(ctx), limits.summaries * CANDIDATES_PER_SLOT)).map((orderId) => ({ id: orderId, orderId }));
      for (const order of await choose('summary', waiting, limits.summaries)) {
        await attempt('summary', order, async () => !!(await summariseOrder(ctx, { orderId: order.id }, model)), () => result.summaries++);
      }
    }
    return result;
  });
}
