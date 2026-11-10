// Pylon events: storing what arrives, and turning it into quotes, contracts and deposits.
import { Prisma, type Db, type PylonEvent } from '@bluven/db';
import {
  AppError,
  ValidationError,
  archiveContractInTx,
  audit,
  cleanupStaged,
  createGatewayDeposit,
  editBlockReason,
  finishImage,
  formatCents,
  getConfig,
  inTx,
  loadOrderState,
  localDateString,
  lockOrder,
  managerIds,
  markQuoteSentInTx,
  newId,
  notifyUsers,
  nowOf,
  orderHref,
  parseDateOnly,
  stageUpload,
  upsertPylonQuote,
  withJobLock,
  type Ctx,
  type OrderState,
  type StagedFile,
} from '@bluven/core';
import { PylonApiError, type PylonApi, type PylonDesign } from './client';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The event names this integration acts on. Everything else is stored and ignored. */
export const HANDLED_EVENTS = [
  'solar_projects.created',
  'solar_projects.updated',
  'solar_designs.created',
  'solar_designs.updated',
  'web_proposals.signed',
  'gateway_payments.created',
] as const;

/**
 * Stores an event exactly as Pylon sent it. Accepts both the webhook body ({ data: event }) and a
 * bare event object from the events list. Storing is idempotent on Pylon's event id.
 */
export async function recordPylonEvent(db: Db, body: unknown, now: Date = new Date()): Promise<{ id: string; name: string; duplicate: boolean }> {
  const event = obj(obj(body).data).id ? obj(obj(body).data) : obj(body);
  const pylonEventId = str(event.id);
  const name = str(obj(event.attributes).name);
  if (!pylonEventId || !name) throw new ValidationError('Not a Pylon event: the id or the event name is missing.');
  const existing = await db.pylonEvent.findUnique({ where: { pylonEventId }, select: { id: true } });
  if (existing) return { id: existing.id, name, duplicate: true };
  const id = newId('pye');
  try {
    await db.pylonEvent.create({ data: { id, pylonEventId, name, payload: event as Prisma.InputJsonValue, receivedAt: now, nextAttemptAt: now } });
  } catch (e) {
    // Two deliveries of the same event raced: the unique index decided.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const row = await db.pylonEvent.findUniqueOrThrow({ where: { pylonEventId }, select: { id: true } });
      return { id: row.id, name, duplicate: true };
    }
    throw e;
  }
  return { id, name, duplicate: false };
}

interface ParsedEvent {
  name: string;
  attributes: Json;
  projectId: string | null;
  designId: string | null;
  reference: string | null;
  createdAt: Date | null;
}

function parseEvent(row: PylonEvent): ParsedEvent {
  const payload = obj(row.payload);
  const attributes = obj(payload.attributes);
  const relationships = obj(payload.relationships);
  const related = (name: string) => str(obj(obj(relationships[name]).data).id);
  const created = str(attributes.created_at);
  const createdAt = created ? new Date(created) : null;
  return {
    name: row.name,
    attributes,
    projectId: related('solar_project'),
    designId: related('solar_design'),
    reference: str(attributes.project_reference_number),
    createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
  };
}

/** Outcome of handling one event. */
type Handled = { status: 'PROCESSED' | 'IGNORED'; note: string; orderId?: string };

class Skip extends Error {
  constructor(
    readonly note: string,
    readonly orderId?: string,
  ) {
    super(note);
  }
}

/**
 * Finds the CRM order an event belongs to: by the reference number Pylon echoes back (our order
 * number), by a project we have already linked, or by asking Pylon for the project's reference.
 */
async function resolveOrder(ctx: Ctx, api: PylonApi | null, ev: ParsedEvent): Promise<string> {
  if (ev.reference) {
    const byRef = await ctx.db.order.findUnique({ where: { orderNo: ev.reference }, select: { id: true } });
    if (byRef) return byRef.id;
  }
  if (ev.projectId) {
    const linked = await ctx.db.order.findFirst({ where: { pylonProjectId: ev.projectId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (linked) return linked.id;
    if (api && !ev.reference) {
      const project = await api.getSolarProject(ev.projectId);
      if (project.referenceNumber) {
        const byRef = await ctx.db.order.findUnique({ where: { orderNo: project.referenceNumber.trim() }, select: { id: true } });
        if (byRef) return byRef.id;
      }
    }
  }
  throw new Skip(ev.reference ? `No CRM order has the number “${ev.reference}”.` : 'This Pylon project is not linked to a CRM order (it has no CRM order number as its reference).');
}

/** Remembers which Pylon project belongs to the order, so the page can link to it. */
async function linkProject(ctx: Ctx, orderId: string, ev: ParsedEvent): Promise<void> {
  if (!ev.projectId) return;
  const url = str(ev.attributes.project_in_app_url);
  const order = await ctx.db.order.findUniqueOrThrow({ where: { id: orderId }, select: { pylonProjectId: true, pylonProjectUrl: true, orderNo: true, customerId: true } });
  if (order.pylonProjectId === ev.projectId && (order.pylonProjectUrl || !url)) return;
  await ctx.db.order.update({ where: { id: orderId }, data: { pylonProjectId: ev.projectId, pylonProjectUrl: url && /^https:\/\//.test(url) ? url : order.pylonProjectUrl } });
  if (order.pylonProjectId !== ev.projectId) {
    await audit(ctx.db, ctx, {
      action: 'order.pylon_link',
      entityType: 'Order',
      entityId: orderId,
      orderId,
      customerId: order.customerId,
      summary: `${order.orderNo}: linked to Pylon project ${ev.projectId}`,
      before: { pylonProjectId: order.pylonProjectId },
      after: { pylonProjectId: ev.projectId },
    });
  }
}

function needApi(api: PylonApi | null): PylonApi {
  if (!api) throw new PylonApiError('The Pylon API token is not configured.', null, true);
  return api;
}

function quoteData(design: PylonDesign) {
  const kw = design.dcOutputKw;
  const kwh = design.storageKwh;
  return {
    pylonDesignId: design.id,
    title: [kw ? `${kw} kW solar` : '', kwh ? `${kwh} kWh battery` : ''].filter(Boolean).join(' with '),
    dcWatts: kw === null ? null : Math.round(kw * 1000),
    storageWh: kwh === null ? null : Math.round(kwh * 1000),
    totalCents: design.totalCents,
    depositCents: design.depositCents,
    currency: design.currency,
    webProposalUrl: design.webProposalUrl && /^https:\/\//.test(design.webProposalUrl) ? design.webProposalUrl : null,
  };
}

/** Orders that are closed or with operations are left alone. */
function requireOpen(order: OrderState): void {
  const reason = editBlockReason(order);
  if (reason) throw new Skip(`Order ${order.orderNo} is not open for changes: ${reason}`, order.id);
}

async function lockedOrder(tx: Prisma.TransactionClient, orderId: string): Promise<OrderState> {
  await lockOrder(tx, orderId);
  return (await loadOrderState(tx, orderId))!;
}

async function handleProject(ctx: Ctx, api: PylonApi | null, ev: ParsedEvent): Promise<Handled> {
  const orderId = await resolveOrder(ctx, api, ev);
  await linkProject(ctx, orderId, ev);
  if (ev.name !== 'solar_projects.updated' || !api || !ev.projectId) return { status: 'PROCESSED', note: 'Project linked.', orderId };

  // A project marked as sold in Pylon without a contract in the CRM: nudge the salesperson once.
  const project = await api.getSolarProject(ev.projectId);
  if (!project.isAccepted) return { status: 'PROCESSED', note: 'Project linked.', orderId };
  return inTx(ctx.db, async (tx) => {
    const order = await lockedOrder(tx, orderId);
    const contract = await tx.contract.findFirst({ where: { orderId, voidedAt: null }, select: { id: true } });
    const nudged = await tx.task.findFirst({ where: { orderId, kind: 'PYLON_ACCEPTED' }, select: { id: true } });
    if (contract || nudged || editBlockReason(order)) return { status: 'PROCESSED' as const, note: 'Project linked.', orderId };
    const now = nowOf(ctx);
    await tx.task.create({
      data: { id: newId('tsk'), orderId, assigneeId: order.ownerId, title: 'Pylon shows this project as accepted: archive the signed contract', dueAt: now, kind: 'PYLON_ACCEPTED', remindedAt: now, createdAt: now },
    });
    await notifyUsers(tx, ctx, order.ownerId ? [order.ownerId] : await managerIds(tx), {
      type: 'pylon.accepted',
      title: `${order.orderNo}: accepted in Pylon, contract not archived yet`,
      body: 'Archive the signed contract in the CRM so the order can move on.',
      href: `${orderHref(orderId)}?tab=deal`,
      orderId,
    });
    return { status: 'PROCESSED' as const, note: 'Project accepted in Pylon; asked sales to archive the contract.', orderId };
  });
}

async function handleDesign(ctx: Ctx, api: PylonApi | null, ev: ParsedEvent): Promise<Handled> {
  if (!ev.designId) throw new Skip('The event does not say which design it is about.');
  const orderId = await resolveOrder(ctx, api, ev);
  await linkProject(ctx, orderId, ev);
  const design = await needApi(api).getSolarDesign(ev.designId);
  if (design.totalCents === null && design.dcOutputKw === null && design.storageKwh === null) {
    return { status: 'IGNORED', note: 'The design has no size or price yet.', orderId };
  }
  const result = await inTx(ctx.db, async (tx) => {
    const order = await lockedOrder(tx, orderId);
    requireOpen(order);
    return upsertPylonQuote(tx, ctx, order, quoteData(design));
  });
  return { status: 'PROCESSED', note: `Quote ${result.outcome.replace('_', ' ')}.`, orderId };
}

async function handleSigned(ctx: Ctx, api: PylonApi | null, ev: ParsedEvent): Promise<Handled> {
  const orderId = await resolveOrder(ctx, api, ev);
  await linkProject(ctx, orderId, ev);
  const pylon = needApi(api);
  if (!ev.projectId) throw new Skip('The event does not say which project it is about.', orderId);
  const project = await pylon.getSolarProject(ev.projectId);
  const designId = ev.designId ?? project.latestSignedDesignId ?? project.primaryDesignId;
  if (!designId) throw new Skip('Pylon did not say which design was signed.', orderId);
  const design = await pylon.getSolarDesign(designId);
  const signedAt = ev.createdAt ?? nowOf(ctx);
  const signedOn = parseDateOnly(localDateString(signedAt, getConfig().timeZone))!;

  let staged: StagedFile | null = null;
  if (project.esignaturePdfUrl) {
    // The link is only valid for an hour, so the PDF is fetched before anything else happens.
    staged = await stageUpload(await pylon.download(project.esignaturePdfUrl), `Signed proposal ${ev.reference ?? project.referenceNumber ?? ''}.pdf`.replace(/\s+\.pdf$/, '.pdf'), 60 * 1024 * 1024);
  }
  try {
    const outcome = await inTx(ctx.db, async (tx) => {
      const order = await lockedOrder(tx, orderId);
      requireOpen(order);
      const quote = await upsertPylonQuote(tx, ctx, order, quoteData(design));
      // Signing a web proposal means the customer has seen it.
      await markQuoteSentInTx(tx, ctx, order, quote.quoteId, { sentAt: signedAt, via: 'PYLON' });
      const live = await tx.contract.findFirst({ where: { orderId, voidedAt: null }, select: { id: true } });
      if (live) return { note: 'Signed in Pylon. A contract was already archived, so it was left as it is.', documents: [] };
      if (!staged) {
        const now = nowOf(ctx);
        await tx.task.create({
          data: { id: newId('tsk'), orderId, assigneeId: order.ownerId, title: 'The customer accepted the Pylon proposal: archive the signed copy', dueAt: now, kind: 'PYLON_ACCEPTED', remindedAt: now, createdAt: now },
        });
        await notifyUsers(tx, ctx, order.ownerId ? [order.ownerId] : await managerIds(tx), {
          type: 'pylon.accepted',
          title: `${order.orderNo}: the customer accepted the proposal in Pylon`,
          body: 'Pylon did not provide a signed PDF. Archive the signed copy in the CRM.',
          href: `${orderHref(orderId)}?tab=deal`,
          orderId,
        });
        return { note: 'Accepted in Pylon without a signed PDF; asked sales to archive the contract.', documents: [] };
      }
      const fresh = (await loadOrderState(tx, orderId))!;
      const archived = await archiveContractInTx(tx, ctx, fresh, { quoteId: quote.quoteId, signedOn, files: [staged], source: 'PYLON' });
      await notifyUsers(tx, ctx, order.ownerId ? [order.ownerId] : await managerIds(tx), {
        type: 'pylon.signed',
        title: `${order.orderNo}: the customer signed the proposal in Pylon`,
        body: 'The signed contract has been archived automatically.',
        href: `${orderHref(orderId)}?tab=deal`,
        orderId,
      });
      return { note: 'Signed contract archived from Pylon.', documents: archived.documents };
    });
    if (staged && outcome.documents.length === 0) await cleanupStaged(staged);
    for (const doc of outcome.documents) await finishImage(ctx, doc);
    return { status: 'PROCESSED', note: outcome.note, orderId };
  } catch (e) {
    if (staged) await cleanupStaged(staged);
    throw e;
  }
}

async function handlePayment(ctx: Ctx, api: PylonApi | null, ev: ParsedEvent, row: PylonEvent): Promise<Handled> {
  const orderId = await resolveOrder(ctx, api, ev);
  await linkProject(ctx, orderId, ev);
  const amount = typeof ev.attributes.amount === 'number' ? Math.round(ev.attributes.amount) : null;
  if (!amount || amount <= 0) throw new Skip('The payment event carries no amount.', orderId);
  const currency = (str(ev.attributes.currency) ?? 'AUD').toUpperCase();
  const receipt = str(ev.attributes.receipt_url);
  const purpose = str(ev.attributes.purpose) ?? 'deposit';
  const outcome = await inTx(ctx.db, async (tx) => {
    const order = await lockedOrder(tx, orderId);
    if (order.sideState === 'LOST' || order.sideState === 'CANCELLED') throw new Skip(`Order ${order.orderNo} is closed.`, orderId);
    return createGatewayDeposit(tx, ctx, order, { amountCents: amount, currency, receiptUrl: receipt && /^https:\/\//.test(receipt) ? receipt : null, pylonEventId: row.pylonEventId });
  });
  const what = `${formatCents(amount, currency)} (${purpose})`;
  return {
    status: 'PROCESSED',
    note: outcome === 'created' ? `Gateway payment of ${what} recorded as a deposit awaiting finance.` : outcome === 'deposit_exists' ? `Gateway payment of ${what} noted; a deposit was already on record.` : 'Already recorded.',
    orderId,
  };
}

async function handle(ctx: Ctx, api: PylonApi | null, row: PylonEvent): Promise<Handled> {
  const ev = parseEvent(row);
  switch (ev.name) {
    case 'solar_projects.created':
    case 'solar_projects.updated':
      return handleProject(ctx, api, ev);
    case 'solar_designs.created':
    case 'solar_designs.updated':
      return handleDesign(ctx, api, ev);
    case 'web_proposals.signed':
      return handleSigned(ctx, api, ev);
    case 'gateway_payments.created':
      return handlePayment(ctx, api, ev, row);
    default:
      return { status: 'IGNORED', note: 'This kind of event needs no action in the CRM.' };
  }
}

/** Minutes to wait before attempt 2, 3, 4, 5 and 6. After that the event is marked as failed. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 360];

export interface ProcessResult {
  processed: number;
  ignored: number;
  retrying: number;
  failed: number;
}

/**
 * Works through stored events that are due. Each event is handled on its own: a failure is
 * recorded on the event and retried with a growing delay, and never blocks the others.
 */
export async function processPylonEvents(ctx: Ctx, api: PylonApi | null, limit = 50): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, ignored: 0, retrying: 0, failed: 0 };
  await withJobLock(ctx.db, 760201, async () => {
    const now = nowOf(ctx);
    const due = await ctx.db.pylonEvent.findMany({ where: { status: 'PENDING', nextAttemptAt: { lte: now } }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: limit });
    for (const row of due) {
      try {
        const handled = await handle(ctx, api, row);
        await ctx.db.pylonEvent.update({
          where: { id: row.id },
          data: { status: handled.status, processedAt: nowOf(ctx), attempts: row.attempts + 1, resultNote: handled.note, orderId: handled.orderId ?? null, lastError: null },
        });
        if (handled.status === 'PROCESSED') result.processed++;
        else result.ignored++;
      } catch (e) {
        const attempts = row.attempts + 1;
        if (e instanceof Skip || (e instanceof AppError && !(e instanceof PylonApiError))) {
          // The event is understood but does not apply (unknown order, closed order, rule refused it).
          await ctx.db.pylonEvent.update({
            where: { id: row.id },
            data: { status: 'IGNORED', processedAt: nowOf(ctx), attempts, resultNote: e.message, orderId: e instanceof Skip ? (e.orderId ?? null) : null, lastError: null },
          });
          result.ignored++;
          continue;
        }
        const message = e instanceof Error ? e.message : String(e);
        const retryable = !(e instanceof PylonApiError) || e.retryable;
        const delay = BACKOFF_MINUTES[attempts - 1];
        if (retryable && delay !== undefined) {
          await ctx.db.pylonEvent.update({ where: { id: row.id }, data: { attempts, lastError: message.slice(0, 1000), nextAttemptAt: new Date(nowOf(ctx).getTime() + delay * 60_000) } });
          result.retrying++;
        } else {
          await ctx.db.pylonEvent.update({ where: { id: row.id }, data: { status: 'FAILED', attempts, lastError: message.slice(0, 1000), processedAt: nowOf(ctx) } });
          result.failed++;
        }
        if (!(e instanceof PylonApiError)) console.error(`[pylon] event ${row.pylonEventId} (${row.name}) failed`, e);
      }
    }
    return true;
  });
  return result;
}

/** Puts a failed or ignored event back in the queue. Admins use this after fixing the cause. */
export async function retryPylonEvent(ctx: Ctx, eventId: string): Promise<void> {
  if (ctx.actor.kind === 'user' && !ctx.actor.roles.includes('ADMIN')) throw new ValidationError('Only an administrator can retry Pylon events.');
  const row = await ctx.db.pylonEvent.findUnique({ where: { id: eventId } });
  if (!row) throw new ValidationError('Event not found.');
  if (row.status === 'PENDING') return;
  await ctx.db.pylonEvent.update({ where: { id: row.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: nowOf(ctx), lastError: null, processedAt: null, resultNote: '' } });
  await audit(ctx.db, ctx, { action: 'pylon.event_retry', entityType: 'PylonEvent', entityId: row.id, orderId: row.orderId, summary: `Queued Pylon event ${row.name} for another attempt`, before: { status: row.status } });
}

/**
 * Catches events whose webhook delivery never arrived by reading Pylon's own event list (kept
 * for 30 days) and storing anything we have not seen. Stops at the first page that is all known.
 */
export async function reconcilePylonEvents(ctx: Ctx, api: PylonApi, maxPages = 20): Promise<{ added: number; pages: number }> {
  let added = 0;
  let pages = 0;
  let next: string | null | undefined;
  do {
    const page = await api.listEvents(next);
    pages++;
    let addedOnPage = 0;
    for (const event of page.events) {
      try {
        if (!(await recordPylonEvent(ctx.db, event, nowOf(ctx))).duplicate) addedOnPage++;
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
      }
    }
    added += addedOnPage;
    next = addedOnPage === 0 ? null : page.next;
  } while (next && pages < maxPages);
  return { added, pages };
}
