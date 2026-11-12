// What the assistant does without being asked: briefs for orders just pushed, a look at new
// attachments, reading new bills, and fresh summaries after a customer has written.
import type { Db } from '@bluven/db';
import { nowOf, withJobLock, type Ctx } from '@bluven/core';
import { pendingAttachments, readAttachment } from './attachments';
import { pendingBills, readBill } from './bills';
import { pendingBriefs, writeHandoffBrief } from './brief';
import { AiError, type AiModel } from './model';
import { automaticAllowanceLeft, getAssistantSettings, mayAttempt, recentSetupProblem, type AiKind } from './runs';
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
}

/** A customer's e-mail has to be this old before the summary is rewritten, so three e-mails in a row make one summary. */
const SETTLE_MS = 2 * 60_000;
/** No new request is started once a round has taken this long; the rest waits for the next round. */
const ROUND_BUDGET_MS = 4 * 60_000;

/** Open orders on which a customer's e-mail arrived after the summary was last written. */
export async function ordersNeedingSummary(db: Db, now: Date, limit: number): Promise<string[]> {
  const orders = await db.order.findMany({
    where: {
      sideState: { in: ['NONE', 'ON_HOLD'] },
      stage: { not: 'HANDED_OVER' },
      activities: { some: { type: 'EMAIL_IN', createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } } },
    },
    select: { id: true, summary: { select: { coversUntil: true } }, activities: { where: { type: 'EMAIL_IN' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
    take: 200,
  });
  return orders
    .filter((o) => {
      const newest = o.activities[0]?.createdAt;
      return !!newest && now.getTime() - newest.getTime() >= SETTLE_MS && (!o.summary || newest > o.summary.coversUntil);
    })
    .sort((a, b) => a.activities[0]!.createdAt.getTime() - b.activities[0]!.createdAt.getTime())
    .slice(0, limit)
    .map((o) => o.id);
}

const LOCK_KEY = 760501;

/**
 * One round of background work. Safe to run every minute: each item is done once, an item that
 * fails waits longer each time before it is tried again, and the whole round stops at the
 * day's allowance. Returns null when another process is already at it.
 */
export async function runAssistantWork(ctx: Ctx, model: AiModel, limits = { briefs: 2, attachments: 4, bills: 2, summaries: 2 }): Promise<AssistantWork | null> {
  return withJobLock(ctx.db, LOCK_KEY, async () => {
    const settings = await getAssistantSettings(ctx.db);
    const result: AssistantWork = { briefs: 0, attachments: 0, bills: 0, summaries: 0, failed: 0, allowanceUsedUp: false, setupProblem: null };
    // A wrong key fails every request the same way: wait for someone to fix it rather than try each item in turn.
    result.setupProblem = await recentSetupProblem(ctx.db, nowOf(ctx));
    if (result.setupProblem) return result;
    const started = Date.now();
    let allowance = await automaticAllowanceLeft(ctx.db, settings, nowOf(ctx));

    /** Runs one item unless the round is over; counts it; never lets one failure stop the rest. */
    const attempt = async (kind: AiKind, subjectId: string, work: () => Promise<boolean>, count: () => void): Promise<void> => {
      if (result.setupProblem || Date.now() - started > ROUND_BUDGET_MS) return;
      if (allowance <= 0) {
        result.allowanceUsedUp = true;
        return;
      }
      if (!(await mayAttempt(ctx.db, kind, subjectId, nowOf(ctx)))) return;
      try {
        // `work` says whether the model was actually asked; what was settled without it costs nothing.
        if (await work()) allowance--;
        count();
      } catch (e) {
        allowance--;
        result.failed++;
        if (e instanceof AiError && e.failure === 'setup') result.setupProblem = e.detail || e.message;
        else if (!(e instanceof AiError)) console.error(`[assistant] ${kind} ${subjectId} failed`, e);
      }
    };

    if (settings.autoBrief) {
      for (const pkg of await pendingBriefs(ctx.db, nowOf(ctx), limits.briefs)) {
        await attempt('brief', pkg.id, async () => !!(await writeHandoffBrief(ctx, { orderId: pkg.orderId }, model)), () => result.briefs++);
      }
    }
    if (settings.readAttachments) {
      for (const id of await pendingAttachments(ctx.db, nowOf(ctx), limits.attachments)) {
        await attempt('attachment', id, async () => (await readAttachment(ctx, id, model)) === 'read', () => result.attachments++);
      }
    }
    if (settings.readBills) {
      for (const id of await pendingBills(ctx.db, nowOf(ctx), limits.bills)) {
        await attempt('bill', id, async () => !!(await readBill(ctx, { documentId: id }, model)), () => result.bills++);
      }
    }
    if (settings.autoSummary) {
      for (const orderId of await ordersNeedingSummary(ctx.db, nowOf(ctx), limits.summaries)) {
        await attempt('summary', orderId, async () => !!(await summariseOrder(ctx, { orderId }, model)), () => result.summaries++);
      }
    }
    return result;
  });
}
