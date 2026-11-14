// Every request to the model goes through here: it is recorded with what it used and how it
// ended, and background work is held back when it keeps failing or has used up the day's allowance.
import { Prisma, type Db } from '@bluven/db';
import { FieldErrors, ForbiddenError, ValidationError, actorId, audit, can, inTx, isManager, newId, nowOf, requireUser, type Ctx } from '@bluven/core';
import { AI_MESSAGES, AiError, type AiModel, type AiRequest, type AiUsage } from './model';

export const AI_KINDS = ['summary', 'reply', 'attachment', 'bill', 'brief'] as const;
export type AiKind = (typeof AI_KINDS)[number];

export const AI_KIND_LABEL: Record<AiKind, string> = {
  summary: 'Order summaries',
  reply: 'Reply drafts',
  attachment: 'Recognising e-mail attachments',
  bill: 'Reading electricity bills',
  brief: 'Briefs for operations',
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const ASSISTANT_LANGUAGES = { en: 'English', zh: 'Chinese (简体中文)' } as const;
export type AssistantLanguage = keyof typeof ASSISTANT_LANGUAGES;

export interface AssistantSettings {
  /** Look at what customers attach to their e-mails and suggest the folder it belongs in. */
  readAttachments: boolean;
  /** Read electricity bills as they are filed. */
  readBills: boolean;
  /** Rewrite an order's summary when the customer writes. */
  autoSummary: boolean;
  /** Write the brief for operations when an order is pushed. */
  autoBrief: boolean;
  /** The language summaries and briefs are written in. Reply drafts follow the customer's language. */
  language: AssistantLanguage;
  /** The most requests the background process may make by itself in any 24 hours. */
  dailyAutomaticLimit: number;
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  readAttachments: true,
  readBills: true,
  autoSummary: true,
  autoBrief: true,
  language: 'en',
  dailyAutomaticLimit: 300,
};

const SETTINGS_KEY = 'assistant';

function sanitize(value: unknown): AssistantSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof AssistantSettings, unknown>>;
  const flag = (key: 'readAttachments' | 'readBills' | 'autoSummary' | 'autoBrief') => (typeof v[key] === 'boolean' ? v[key] : DEFAULT_ASSISTANT_SETTINGS[key]);
  const limit = typeof v.dailyAutomaticLimit === 'number' && Number.isInteger(v.dailyAutomaticLimit) && v.dailyAutomaticLimit >= 0 ? v.dailyAutomaticLimit : DEFAULT_ASSISTANT_SETTINGS.dailyAutomaticLimit;
  return {
    readAttachments: flag('readAttachments'),
    readBills: flag('readBills'),
    autoSummary: flag('autoSummary'),
    autoBrief: flag('autoBrief'),
    language: v.language === 'zh' ? 'zh' : 'en',
    dailyAutomaticLimit: limit,
  };
}

export async function getAssistantSettings(db: Pick<Db, 'setting'>): Promise<AssistantSettings> {
  const row = await db.setting.findUnique({ where: { key: SETTINGS_KEY } });
  return sanitize(row?.value);
}

export async function updateAssistantSettings(ctx: Ctx, next: AssistantSettings): Promise<AssistantSettings> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'admin.settings')) throw new ForbiddenError();
  const errors = new FieldErrors();
  if (!Number.isInteger(next.dailyAutomaticLimit) || next.dailyAutomaticLimit < 0 || next.dailyAutomaticLimit > 100_000) errors.add('dailyAutomaticLimit', 'Enter a whole number between 0 and 100,000.');
  if (!(next.language in ASSISTANT_LANGUAGES)) errors.add('language', 'Choose a language.');
  errors.throwIfAny();
  const clean = sanitize(next);
  return inTx(ctx.db, async (tx) => {
    const before = await getAssistantSettings(tx);
    const value = clean as unknown as Prisma.InputJsonValue;
    await tx.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value, updatedById: actorId(ctx) }, update: { value, updatedById: actorId(ctx) } });
    await audit(tx, ctx, { action: 'settings.update', entityType: 'Setting', entityId: SETTINGS_KEY, summary: 'Updated the assistant’s settings', before, after: clean });
    return clean;
  });
}

// ---------------------------------------------------------------------------
// Running a request
// ---------------------------------------------------------------------------

export interface AiRunMeta {
  kind: AiKind;
  orderId?: string | null;
  /** The attachment, document or handoff package the request is about. */
  subjectId?: string | null;
}

/** Thrown by a `parse` function when the model's answer does not have the shape that was asked for. */
export function unusable(detail: string): AiError {
  return new AiError(AI_MESSAGES.unreadable, 'unreadable', detail);
}

/** The most requests one person can make with the assistant's buttons in an hour. Far more than work needs; a stuck key or a script stops here. */
export const REQUESTS_PER_PERSON_PER_HOUR = 60;
/** The first half of the lock under which one person's requests are counted. The second half is worked out from who it is. */
const PERSON_LOCK_SPACE = 7607;

/**
 * Sends one request, checks the answer and records the outcome. `parse` turns the raw answer
 * into the value the caller wants and throws (see `unusable`) when it cannot.
 *
 * The request is on record before it is sent, as STARTED, and the record is completed when the
 * answer is in. For a person, counting the last hour's requests and adding this one happen
 * under a lock of that person's own, so that requests sent at the same moment are counted one
 * after another and the limit holds however they arrive.
 */
export async function runAi<T>(ctx: Ctx, model: AiModel, meta: AiRunMeta, request: AiRequest, parse: (output: unknown) => T): Promise<{ value: T; model: string }> {
  const asker = actorId(ctx);
  const id = newId('air');
  const opening = { id, kind: meta.kind, orderId: meta.orderId ?? null, subjectId: meta.subjectId ?? null, userId: asker, model: model.name, status: 'STARTED' as const, createdAt: nowOf(ctx) };
  if (asker) {
    await inTx(ctx.db, async (tx) => {
      // Two numbers, not one: such locks cannot meet those of the background jobs and of the
      // intake, which are taken by a single number. As text, because the function returns
      // nothing, which the database client cannot read back.
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${PERSON_LOCK_SPACE}::int, hashtext(${asker}))::text AS "locked"`);
      const recent = await tx.aiRun.count({ where: { userId: asker, createdAt: { gte: new Date(nowOf(ctx).getTime() - 3_600_000) } } });
      if (recent >= REQUESTS_PER_PERSON_PER_HOUR) throw new ValidationError('You have asked the assistant a great deal in the last hour. Please try again a little later.');
      await tx.aiRun.create({ data: opening });
    });
  } else {
    await ctx.db.aiRun.create({ data: opening });
  }
  const started = Date.now();
  const record = async (status: 'OK' | 'REFUSED' | 'FAILED', usage: AiUsage, servedBy: string, failure: AiError | null) => {
    await ctx.db.aiRun.update({
      where: { id },
      data: {
        model: servedBy,
        status,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        durationMs: Date.now() - started,
        failure: failure?.failure ?? null,
        error: failure ? (failure.detail || failure.message).slice(0, 1000) : null,
      },
    });
  };
  let response;
  try {
    response = await model.run(request);
  } catch (e) {
    const failure = e instanceof AiError ? e : new AiError(AI_MESSAGES.unavailable, 'unavailable', e instanceof Error ? e.message : String(e));
    await record(failure.failure === 'refused' ? 'REFUSED' : 'FAILED', failure.usage, failure.servedBy ?? model.name, failure);
    throw failure;
  }
  let value: T;
  try {
    value = parse(response.output);
  } catch (e) {
    const failure = e instanceof AiError ? e : unusable(e instanceof Error ? e.message : String(e));
    await record('FAILED', response.usage, response.model, failure);
    throw failure;
  }
  await record('OK', response.usage, response.model, null);
  return { value, model: response.model };
}

// ---------------------------------------------------------------------------
// Holding background work back
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * Waits after a failure that is about the item itself (a file the model cannot make sense of,
 * a request the service will not take, a refusal): 10 minutes, 30, 90, and after the fourth
 * such failure within a day the item rests until the day has passed.
 */
const ITEM_WAITS_MIN = [10, 30, 90];
const MAX_ITEM_FAILURES_PER_DAY = ITEM_WAITS_MIN.length + 1;
/**
 * Waits after a failure of the service (it could not be reached, it was overloaded, it took too
 * long). These say little about the item, so they do not use up its four chances, and after an
 * outage of a morning the item is tried again within the hour. They still space its attempts
 * out, because a file that times out every time looks exactly like this: 10 minutes, 30, then
 * every hour, and a rest after eight within a day.
 */
const SERVICE_WAITS_MIN = [10, 30, 60];
const MAX_SERVICE_FAILURES_PER_DAY = 8;

/**
 * Which of these items background work may try now. A failure of the key or the account is
 * never held against an item: it holds everything back for a while instead (see servicePause).
 * One query for the whole batch, so that a long queue costs no more to look at than a short one.
 */
export async function dueSubjects(db: Db, kind: AiKind, subjectIds: string[], now: Date): Promise<Set<string>> {
  const due = new Set(subjectIds);
  if (subjectIds.length === 0) return due;
  const groups = await db.aiRun.groupBy({
    by: ['subjectId', 'failure'],
    where: { kind, subjectId: { in: subjectIds }, status: { in: ['FAILED', 'REFUSED'] }, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const held = new Map<string, { item: number; itemAt: number; service: number; serviceAt: number }>();
  for (const g of groups) {
    if (!g.subjectId || g.failure === 'setup') continue;
    const h = held.get(g.subjectId) ?? { item: 0, itemAt: 0, service: 0, serviceAt: 0 };
    const at = g._max.createdAt?.getTime() ?? 0;
    if (g.failure === 'unavailable') {
      h.service += g._count._all;
      h.serviceAt = Math.max(h.serviceAt, at);
    } else {
      h.item += g._count._all;
      h.itemAt = Math.max(h.itemAt, at);
    }
    held.set(g.subjectId, h);
  }
  for (const [id, h] of held) {
    const itemDue = h.item === 0 || (h.item < MAX_ITEM_FAILURES_PER_DAY && now.getTime() - h.itemAt >= ITEM_WAITS_MIN[h.item - 1]! * MINUTE_MS);
    const serviceDue = h.service === 0 || (h.service < MAX_SERVICE_FAILURES_PER_DAY && now.getTime() - h.serviceAt >= SERVICE_WAITS_MIN[Math.min(h.service, SERVICE_WAITS_MIN.length) - 1]! * MINUTE_MS);
    if (!itemDue || !serviceDue) due.delete(id);
  }
  return due;
}

/** Whether background work on one item may be tried now. See dueSubjects for the rule. */
export async function mayAttempt(db: Db, kind: AiKind, subjectId: string, now: Date): Promise<boolean> {
  return (await dueSubjects(db, kind, [subjectId], now)).has(subjectId);
}

const SETUP_PAUSE_MS = 15 * MINUTE_MS;
const OUTAGE_PAUSE_MS = 5 * MINUTE_MS;

/**
 * What the service last said was wrong with the key or the account, when that was within the
 * last quarter of an hour. Background work pauses for that long instead of failing every minute;
 * a request that has succeeded since clears it.
 */
export async function recentSetupProblem(db: Db, now: Date): Promise<string | null> {
  const last = await db.aiRun.findFirst({ where: { createdAt: { gte: new Date(now.getTime() - SETUP_PAUSE_MS) }, OR: [{ status: 'OK' }, { failure: 'setup' }] }, orderBy: { createdAt: 'desc' }, select: { status: true, error: true } });
  return last && last.status !== 'OK' ? (last.error ?? 'The key or the account is not accepted.') : null;
}

/**
 * Why background work as a whole should wait, or null when it may go on. A wrong key or account
 * holds it for a quarter of an hour; a service that could not be reached holds it for five
 * minutes. Either is over as soon as any request has succeeded. Trouble of this kind hits every
 * item alike, so it is waited out once, here, and not charged to whichever item was being tried.
 */
export async function servicePause(db: Db, now: Date): Promise<{ reason: 'setup' | 'unavailable'; detail: string } | null> {
  const setup = await recentSetupProblem(db, now);
  if (setup) return { reason: 'setup', detail: setup };
  const last = await db.aiRun.findFirst({ where: { createdAt: { gte: new Date(now.getTime() - OUTAGE_PAUSE_MS) }, OR: [{ status: 'OK' }, { failure: 'unavailable' }] }, orderBy: { createdAt: 'desc' }, select: { status: true, error: true } });
  return last && last.status !== 'OK' ? { reason: 'unavailable', detail: last.error ?? 'The service could not be reached.' } : null;
}

const ABANDONED_AFTER_MS = 15 * MINUTE_MS;

/**
 * Completes the record of requests whose outcome was never written: the server stopped while
 * they were running. No request takes a quarter of an hour, so one that is still open after
 * that long is closed as a failure of the service, which is what it was from the item's side.
 */
export async function closeAbandonedRuns(db: Db, now: Date): Promise<number> {
  const { count } = await db.aiRun.updateMany({
    where: { status: 'STARTED', createdAt: { lt: new Date(now.getTime() - ABANDONED_AFTER_MS) } },
    data: { status: 'FAILED', failure: 'unavailable', error: 'The server stopped while this request was running, so its outcome is not known.' },
  });
  return count;
}

/** How many more requests the background process may make now without passing the daily allowance. Requests that are still running count. */
export async function automaticAllowanceLeft(db: Db, settings: AssistantSettings, now: Date): Promise<number> {
  const used = await db.aiRun.count({ where: { userId: null, createdAt: { gte: new Date(now.getTime() - DAY_MS) } } });
  return Math.max(0, settings.dailyAutomaticLimit - used);
}

/**
 * The most requests the background process makes for one order in any 24 hours. One customer who
 * sends forty attachments must not use up the day's allowance for everybody else's orders: what
 * is over the limit waits until the day has passed.
 */
export const AUTOMATIC_REQUESTS_PER_ORDER_PER_DAY = 25;

/** How many automatic requests each of these orders has had in the last 24 hours. Orders without any are not in the map. */
export async function automaticRequestsByOrder(db: Db, orderIds: string[], now: Date): Promise<Map<string, number>> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return new Map();
  const groups = await db.aiRun.groupBy({ by: ['orderId'], where: { userId: null, orderId: { in: ids }, createdAt: { gte: new Date(now.getTime() - DAY_MS) } }, _count: { _all: true } });
  return new Map(groups.filter((g) => g.orderId).map((g) => [g.orderId!, g._count._all]));
}

/**
 * Whether a rejection that has just been recorded for an item settles it for good. The service
 * rejects a request about a file it cannot process, and then asking again only costs money. But
 * it answers the same way when the account has reached a spend limit its owner set, or when
 * something is wrong with requests in general, and then every waiting item would be written off
 * one after the other. So a rejection counts as the item's own only once the service has shown
 * that it works: this item was rejected before, and some request has succeeded since then.
 */
export async function rejectionSettles(db: Db, kind: AiKind, subjectId: string): Promise<boolean> {
  const rejections = await db.aiRun.findMany({ where: { kind, subjectId, failure: 'rejected' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2, select: { createdAt: true } });
  const earlier = rejections[1];
  if (!earlier) return false;
  return !!(await db.aiRun.findFirst({ where: { status: 'OK', createdAt: { gt: earlier.createdAt } }, select: { id: true } }));
}

// ---------------------------------------------------------------------------
// Usage, for the administration page
// ---------------------------------------------------------------------------

type Price = [input: number, output: number, cacheRead?: number];

/**
 * US dollars per million tokens as listed in November 2026: input, output and, where the price
 * list states it, input read from the cache (otherwise a tenth of the input price is assumed).
 */
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

/** A request whose prompt is longer than this many tokens is charged by a model's second price list, where it has one. */
export const LONG_PROMPT_TOKENS = 100_000;

/** The prices for requests with a long prompt, for the models that charge those differently. */
const LONG_PROMPT_PRICES: Record<string, Price> = {
  'claude-haiku-5-5': [0.5, 2.5],
};

type TokenCounts = Pick<AiUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;

/** The length of a request's prompt: what was sent as new input, read from the cache and written to it. */
export const promptTokens = (usage: Pick<AiUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number => usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

/**
 * A rough cost in US dollars, or null for a model whose price is not known here. The counts may
 * be those of one request or of many added up; `longPrompt` says that they are requests whose
 * prompt was over LONG_PROMPT_TOKENS, which some models charge at a higher rate. For one
 * request it is worked out from the counts when left out.
 */
export function estimateCostUsd(model: string, usage: TokenCounts, opts: { longPrompt?: boolean } = {}): number | null {
  const longPrompt = opts.longPrompt ?? promptTokens(usage) > LONG_PROMPT_TOKENS;
  const price = (longPrompt ? LONG_PROMPT_PRICES[model] : undefined) ?? PRICES[model];
  if (!price) return null;
  const [input, output, cacheRead = input / 10] = price;
  // Writing to the cache costs a quarter more than plain input.
  return (usage.inputTokens * input + usage.cacheWriteTokens * input * 1.25 + usage.cacheReadTokens * cacheRead + usage.outputTokens * output) / 1_000_000;
}

export interface AssistantUsage {
  days: number;
  byKind: { kind: AiKind; requests: number; failed: number; inputTokens: number; outputTokens: number; costUsd: number | null }[];
  total: { requests: number; failed: number; inputTokens: number; outputTokens: number; costUsd: number | null };
  automaticLast24h: number;
  recentFailures: { id: string; kind: string; at: Date; model: string; failure: string | null; error: string; orderId: string | null; orderNo: string | null; automatic: boolean }[];
}

/** What the assistant did over the last `days` days. Managers and admins only. */
export async function getAssistantUsage(ctx: Ctx, days = 30): Promise<AssistantUsage> {
  const actor = requireUser(ctx);
  if (!isManager(actor)) throw new ForbiddenError();
  const now = nowOf(ctx);
  const since = new Date(now.getTime() - days * DAY_MS);
  const [groups, automaticLast24h, failures] = await Promise.all([
    // Requests with a long prompt are added up apart from the others: a sum over all of them
    // could not tell which tokens were charged at which rate.
    ctx.db.$queryRaw<{ kind: string; model: string; status: string; longPrompt: boolean; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }[]>(Prisma.sql`
      SELECT "kind", "model", "status"::text AS "status",
             ("inputTokens" + "cacheReadTokens" + "cacheWriteTokens") > ${LONG_PROMPT_TOKENS} AS "longPrompt",
             COUNT(*)::int AS "requests",
             COALESCE(SUM("inputTokens"), 0)::float8 AS "inputTokens", COALESCE(SUM("outputTokens"), 0)::float8 AS "outputTokens",
             COALESCE(SUM("cacheReadTokens"), 0)::float8 AS "cacheReadTokens", COALESCE(SUM("cacheWriteTokens"), 0)::float8 AS "cacheWriteTokens"
      FROM "AiRun" WHERE "createdAt" >= ${since}
      GROUP BY 1, 2, 3, 4`),
    ctx.db.aiRun.count({ where: { userId: null, createdAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
    ctx.db.aiRun.findMany({ where: { status: { in: ['FAILED', 'REFUSED'] }, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 15 }),
  ]);
  const orderNos = new Map((await ctx.db.order.findMany({ where: { id: { in: failures.map((f) => f.orderId).filter((id): id is string => !!id) } }, select: { id: true, orderNo: true } })).map((o) => [o.id, o.orderNo]));

  const blank = () => ({ requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 as number | null });
  const byKind = new Map<AiKind, ReturnType<typeof blank>>(AI_KINDS.map((k) => [k, blank()]));
  const total = blank();
  for (const g of groups) {
    const usage = { inputTokens: g.inputTokens, outputTokens: g.outputTokens, cacheReadTokens: g.cacheReadTokens, cacheWriteTokens: g.cacheWriteTokens };
    const cost = estimateCostUsd(g.model, usage, { longPrompt: g.longPrompt });
    for (const row of [byKind.get(g.kind as AiKind), total]) {
      if (!row) continue;
      row.requests += g.requests;
      // A request that is still running has neither succeeded nor failed.
      if (g.status === 'FAILED' || g.status === 'REFUSED') row.failed += g.requests;
      row.inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      row.outputTokens += usage.outputTokens;
      // One model without a known price makes the sum unknown rather than too low.
      row.costUsd = row.costUsd === null || cost === null ? null : row.costUsd + cost;
    }
  }
  return {
    days,
    byKind: AI_KINDS.map((kind) => ({ kind, ...byKind.get(kind)! })),
    total,
    automaticLast24h,
    recentFailures: failures.map((f) => ({ id: f.id, kind: f.kind, at: f.createdAt, model: f.model, failure: f.failure, error: f.error ?? '', orderId: f.orderId, orderNo: f.orderId ? (orderNos.get(f.orderId) ?? null) : null, automatic: f.userId === null })),
  };
}
