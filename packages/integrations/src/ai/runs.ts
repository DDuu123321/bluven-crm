// Every request to the model goes through here: it is recorded with what it used and how it
// ended, and background work is held back when it keeps failing or has used up the day's allowance.
import type { Db, Prisma } from '@bluven/db';
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

/**
 * Sends one request, checks the answer and records the outcome. `parse` turns the raw answer
 * into the value the caller wants and throws (see `unusable`) when it cannot.
 */
export async function runAi<T>(ctx: Ctx, model: AiModel, meta: AiRunMeta, request: AiRequest, parse: (output: unknown) => T): Promise<{ value: T; model: string }> {
  const asker = actorId(ctx);
  if (asker) {
    const recent = await ctx.db.aiRun.count({ where: { userId: asker, createdAt: { gte: new Date(nowOf(ctx).getTime() - 3_600_000) } } });
    if (recent >= REQUESTS_PER_PERSON_PER_HOUR) throw new ValidationError('You have asked the assistant a great deal in the last hour. Please try again a little later.');
  }
  const started = Date.now();
  const record = async (status: 'OK' | 'REFUSED' | 'FAILED', usage: AiUsage, servedBy: string, failure: AiError | null) => {
    await ctx.db.aiRun.create({
      data: {
        id: newId('air'),
        kind: meta.kind,
        orderId: meta.orderId ?? null,
        subjectId: meta.subjectId ?? null,
        userId: actorId(ctx),
        model: servedBy,
        status,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        durationMs: Date.now() - started,
        failure: failure?.failure ?? null,
        error: failure ? (failure.detail || failure.message).slice(0, 1000) : null,
        createdAt: nowOf(ctx),
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
/** After this many failures within a day the item is left alone until the day has passed. */
const MAX_FAILURES_PER_DAY = 4;
const FIRST_RETRY_MS = 10 * 60_000;

/**
 * Whether background work on one item may be tried now. Each failure triples the wait
 * (10 minutes, 30, 90), and after four failures within a day the item rests for the day.
 * A failure that only a person can fix (the key, the account) holds everything back for a while.
 */
export async function mayAttempt(db: Db, kind: AiKind, subjectId: string, now: Date): Promise<boolean> {
  const failures = await db.aiRun.findMany({ where: { kind, subjectId, status: { not: 'OK' }, createdAt: { gte: new Date(now.getTime() - DAY_MS) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (failures.length === 0) return true;
  if (failures.length >= MAX_FAILURES_PER_DAY) return false;
  return now.getTime() - failures[0]!.createdAt.getTime() >= FIRST_RETRY_MS * 3 ** (failures.length - 1);
}

const SETUP_PAUSE_MS = 15 * 60_000;

/**
 * What the service last said was wrong with the key or the account, when that was within the
 * last quarter of an hour. Background work pauses for that long instead of failing every minute;
 * a request that has succeeded since clears it.
 */
export async function recentSetupProblem(db: Db, now: Date): Promise<string | null> {
  const last = await db.aiRun.findFirst({ where: { createdAt: { gte: new Date(now.getTime() - SETUP_PAUSE_MS) }, OR: [{ status: 'OK' }, { failure: 'setup' }] }, orderBy: { createdAt: 'desc' }, select: { status: true, error: true } });
  return last && last.status !== 'OK' ? (last.error ?? 'The key or the account is not accepted.') : null;
}

/** How many more requests the background process may make now without passing the daily allowance. */
export async function automaticAllowanceLeft(db: Db, settings: AssistantSettings, now: Date): Promise<number> {
  const used = await db.aiRun.count({ where: { userId: null, createdAt: { gte: new Date(now.getTime() - DAY_MS) } } });
  return Math.max(0, settings.dailyAutomaticLimit - used);
}

// ---------------------------------------------------------------------------
// Usage, for the administration page
// ---------------------------------------------------------------------------

/**
 * US dollars per million tokens as listed in November 2026: input, output and, where the price
 * list states it, input read from the cache (otherwise a tenth of the input price is assumed).
 */
const PRICES: Record<string, [input: number, output: number, cacheRead?: number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

/** A rough cost in US dollars, or null for a model whose price is not known here. */
export function estimateCostUsd(model: string, usage: Pick<AiUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number | null {
  const price = PRICES[model];
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
    ctx.db.aiRun.groupBy({
      by: ['kind', 'model', 'status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
    }),
    ctx.db.aiRun.count({ where: { userId: null, createdAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
    ctx.db.aiRun.findMany({ where: { status: { not: 'OK' }, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 15 }),
  ]);
  const orderNos = new Map((await ctx.db.order.findMany({ where: { id: { in: failures.map((f) => f.orderId).filter((id): id is string => !!id) } }, select: { id: true, orderNo: true } })).map((o) => [o.id, o.orderNo]));

  const blank = () => ({ requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 as number | null });
  const byKind = new Map<AiKind, ReturnType<typeof blank>>(AI_KINDS.map((k) => [k, blank()]));
  const total = blank();
  for (const g of groups) {
    const usage = { inputTokens: g._sum.inputTokens ?? 0, outputTokens: g._sum.outputTokens ?? 0, cacheReadTokens: g._sum.cacheReadTokens ?? 0, cacheWriteTokens: g._sum.cacheWriteTokens ?? 0 };
    const cost = estimateCostUsd(g.model, usage);
    for (const row of [byKind.get(g.kind as AiKind), total]) {
      if (!row) continue;
      row.requests += g._count._all;
      if (g.status !== 'OK') row.failed += g._count._all;
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
