// Pulls new leads from the Bluven website.
//
// The website's CMS keeps every quote request and assessment in its own database and offers them
// at GET /api/crm/leads?since=<ISO time> to whoever presents the shared key. The CRM asks once a
// minute. Nothing has to change on the website, and nothing is lost while the CRM is down: the
// next pull simply picks up where the last one stopped.
import { COMPONENTS, audit, ingestLeads, inTx, notifyRoles, nowOf, SOURCE_KEY, withJobLock, type Ctx, type IngestSummary } from '@bluven/core';
import type { Db, Prisma } from '@bluven/db';

/** One item as the website returns it. Only what is used here is typed; the rest passes through. */
interface WebsiteLead {
  kind?: unknown;
  externalId?: unknown;
  createdAt?: unknown;
  source?: unknown;
  title?: unknown;
  [field: string]: unknown;
}

/** The website returns at most this many of each kind per request. */
const PAGE_LIMIT = 200;
const MAX_ROUNDS = 20;
const REQUEST_TIMEOUT_MS = 20_000;
const STATE_KEY = 'bluvenLeadPull';
const LOCK_KEY = 760401;
/** After this many failed pulls in a row the administrators are told, once. */
const ALERT_AFTER_FAILURES = 5;
const FIRST_RUN_SLACK_MS = 5 * 60_000;

export interface BluvenPullState {
  /** Leads created at or after this instant are asked for next. */
  since: string;
  /** Leads created exactly at `since` that have been dealt with (the website answers "at or after"). */
  seen: string[];
  /** Leads created before this are history: they were there before the connection was switched on. */
  historyBefore: string;
  lastRunAt: string | null;
  lastOkAt: string | null;
  /** When a lead last arrived. */
  lastLeadAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  alerted: boolean;
  /** Leads taken over since the connection was switched on. */
  imported: number;
}

export interface BluvenPullResult {
  fetched: number;
  created: number;
  duplicates: number;
  alreadyReceived: number;
  failed: number;
}

export interface BluvenPullOptions {
  url: string;
  key: string;
  /** Take over leads created since this time as history on the first run. Empty: start from now. */
  since?: string;
  fetchImpl?: typeof fetch;
}

const SOURCE_DETAIL: Record<string, string> = {
  WEBSITE_QUOTE: 'website/quote-form',
  WEBSITE_ASSESSMENT: 'website/assessment',
  AI_CHAT: 'website/ai-chat',
  PARTNER: 'website/partner',
};

/**
 * Turns a website item into a lead for intake. Every field with a standard lead name is passed
 * through, so details the website adds to its answer later (bill, timeline, notes…) arrive
 * without a change here.
 */
export function websiteItemToLead(item: WebsiteLead): Record<string, unknown> {
  const { kind, source, title, ...lead } = item;
  lead.sourceDetail = (typeof source === 'string' && SOURCE_DETAIL[source]) || (kind === 'assessment' ? SOURCE_DETAIL.WEBSITE_ASSESSMENT : 'website');
  // Until the website sends the list itself, what the customer is interested in comes as "Solar + Battery".
  if (lead.components === undefined && typeof title === 'string') {
    const parts = title.split('+').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0 && parts.every((p) => (COMPONENTS as readonly string[]).includes(p))) lead.components = parts;
  }
  return lead;
}

export async function getBluvenPullState(db: Db): Promise<BluvenPullState | null> {
  const row = await db.setting.findUnique({ where: { key: STATE_KEY } });
  return row ? (row.value as unknown as BluvenPullState) : null;
}

async function saveState(db: Db, state: BluvenPullState): Promise<void> {
  const value = state as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } });
}

class PullError extends Error {}

async function fetchPage(opts: BluvenPullOptions, since: string): Promise<WebsiteLead[]> {
  const url = new URL(opts.url);
  url.searchParams.set('since', since);
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${opts.key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    throw new PullError(`The website could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (response.status === 401 || response.status === 403) throw new PullError('The website refused the key. BLUVEN_LEADS_KEY here must equal CRM_SYNC_KEY on the website.');
  if (response.status === 503) throw new PullError('The website answered that lead sync is not switched on there (CRM_SYNC_KEY is not set on the website).');
  if (!response.ok) throw new PullError(`The website answered with status ${response.status}.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PullError('The website did not answer with JSON. Check that BLUVEN_LEADS_URL ends in /api/crm/leads.');
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new PullError('The website answered in a form this version does not understand (no "items" list).');
  return items.filter((i): i is WebsiteLead => typeof i === 'object' && i !== null);
}

const timeOf = (item: WebsiteLead): number => (typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : NaN);

/**
 * Asks the website for leads created since the last pull and takes them in. Safe to call as
 * often as you like and from several processes: a lead is only ever taken once.
 * Returns null when another run is in progress.
 */
export async function pullBluvenLeads(ctx: Ctx, opts: BluvenPullOptions): Promise<BluvenPullResult | null> {
  const db = ctx.db as Db;
  return withJobLock(db, LOCK_KEY, async () => {
    const now = nowOf(ctx);
    const source = await db.leadSource.findUniqueOrThrow({ where: { key: SOURCE_KEY.bluven } });
    let state = await getBluvenPullState(db);
    if (!state) {
      // First run. Unless told to go back further, only what arrives from now on is taken; the
      // few minutes of slack cover a difference between the two servers' clocks. With an explicit
      // start, everything from then until this moment is history.
      const explicit = opts.since && !Number.isNaN(Date.parse(opts.since)) ? new Date(opts.since) : null;
      const from = explicit ?? new Date(now.getTime() - FIRST_RUN_SLACK_MS);
      state = { since: from.toISOString(), seen: [], historyBefore: (explicit ? now : from).toISOString(), lastRunAt: null, lastOkAt: null, lastLeadAt: null, lastError: null, consecutiveFailures: 0, alerted: false, imported: 0 };
    }
    const result: BluvenPullResult = { fetched: 0, created: 0, duplicates: 0, alreadyReceived: 0, failed: 0 };
    const problems = new Set<string>();
    state.lastRunAt = now.toISOString();

    try {
      if (!source.isActive) throw new PullError('The "Bluven website" intake channel is switched off in the CRM.');
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const page = await fetchPage(opts, state.since);
        const fresh = page.filter((i) => typeof i.externalId === 'string' && !state!.seen.includes(i.externalId) && !Number.isNaN(timeOf(i)));
        result.fetched += fresh.length;

        // What was already there when the connection was switched on is history: no pool, no notices.
        const historyBefore = Date.parse(state.historyBefore);
        for (const [backfill, items] of [[true, fresh.filter((i) => timeOf(i) < historyBefore)], [false, fresh.filter((i) => timeOf(i) >= historyBefore)]] as const) {
          if (items.length === 0) continue;
          const summary: IngestSummary = await ingestLeads(ctx, items.map(websiteItemToLead), { sourceId: source.id, requireExternalId: true, backfill });
          result.created += summary.created;
          result.duplicates += summary.duplicates;
          result.alreadyReceived += summary.alreadyReceived;
          result.failed += summary.failed;
          for (const r of summary.results) if (!r.ok) problems.add(`${String(items[r.index]?.externalId)}: ${r.error}`);
        }

        // Move the mark forward. A kind that came back full may have more waiting, so the mark
        // may not pass the last item of that kind; everything up to it has been dealt with.
        const lastOf = (kind: string) => Math.max(...page.filter((i) => i.kind === kind).map(timeOf).filter((t) => !Number.isNaN(t)));
        const full = ['quote', 'assessment'].filter((kind) => page.filter((i) => i.kind === kind).length >= PAGE_LIMIT);
        const times = page.map(timeOf).filter((t) => !Number.isNaN(t));
        if (times.length === 0) break;
        const next = full.length > 0 ? Math.min(...full.map(lastOf)) : Math.max(...times);
        const nextIso = new Date(next).toISOString();
        const atMark = page.filter((i) => timeOf(i) === next && typeof i.externalId === 'string').map((i) => i.externalId as string);
        const stalled = full.length > 0 && nextIso === state.since && atMark.every((id) => state!.seen.includes(id));
        state.seen = nextIso === state.since ? [...new Set([...state.seen, ...atMark])] : atMark;
        state.since = nextIso;
        if (fresh.length > 0) state.lastLeadAt = now.toISOString();
        if (full.length === 0) break;
        if (stalled) throw new PullError(`More than ${PAGE_LIMIT} leads on the website share one creation time, so the CRM cannot page past them.`);
      }
      state.lastOkAt = now.toISOString();
      state.lastError = null;
      state.consecutiveFailures = 0;
      state.alerted = false;
      state.imported += result.created + result.duplicates;
    } catch (e) {
      if (!(e instanceof PullError)) throw e;
      state.lastError = e.message;
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= ALERT_AFTER_FAILURES && !state.alerted) {
        state.alerted = true;
        await notifyRoles(db, ctx, ['ADMIN'], {
          type: 'intake.pull_failing',
          title: 'Leads from the Bluven website are not arriving',
          body: `${e.message}\nNothing is lost: the website keeps the leads and they will come in once the connection works again.`,
          href: '/settings/intake-channels',
        });
      }
    }

    if (problems.size > 0) {
      const list = [...problems];
      await inTx(db, async (tx) => {
        await audit(tx, ctx, {
          action: 'lead.pull_rejected',
          entityType: 'LeadSource',
          entityId: source.id,
          summary: `${list.length} website lead${list.length === 1 ? '' : 's'} could not be taken over`,
          meta: { problems: list.slice(0, 50) },
        });
        await notifyRoles(tx, ctx, ['MANAGER'], {
          type: 'intake.pull_rejected',
          title: list.length === 1 ? 'A lead from the website could not be taken over' : `${list.length} leads from the website could not be taken over`,
          body: `${list.slice(0, 5).join('\n')}${list.length > 5 ? `\n…and ${list.length - 5} more` : ''}\nThey are still in the website's admin under Leads; enter them by hand if needed.`,
          href: '/audit?action=lead.pull_rejected',
        });
      });
    }
    await saveState(db, state);
    return result;
  });
}
