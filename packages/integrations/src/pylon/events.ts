// Pylon events: storing what arrives, and turning it into quotes, contracts and deposits.
import { Prisma, type Db, type Document, type PylonEvent } from '@bluven/db';
import {
  AppError,
  ConflictError,
  ValidationError,
  addActivity,
  archiveContractInTx,
  attachStaged,
  audit,
  cleanupStaged,
  createGatewayDeposit,
  editBlockReason,
  finishImage,
  formatCents,
  getConfig,
  inTx,
  isManager,
  loadOrderState,
  localDateString,
  lockOrder,
  managerIds,
  markQuoteSentInTx,
  newId,
  notifyRoles,
  notifyUsers,
  nowOf,
  orderHref,
  parseDateOnly,
  requireEditableOrder,
  stageUpload,
  upsertPylonQuote,
  withJobLock,
  type Ctx,
  type OrderState,
  type StagedFile,
} from '@bluven/core';
import { PylonApiError, parsePylonProjectRef, pylonProjectUrl, type PylonApi, type PylonDesign, type PylonProject } from './client';

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
  /** The event itself says which reference the project carries, even if that is "none". */
  referenceKnown: boolean;
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
    referenceKnown: typeof attributes.project_reference_number === 'string',
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
 * Finds the CRM order an event belongs to. A project we already know keeps its order whatever an
 * event says; otherwise the reference number Pylon echoes back (our order number) decides, asked
 * from Pylon when the event does not carry it.
 *
 * The reference is typed, or passed in a link, by a person. So an order that is already tied to
 * one Pylon project is never handed to a second project that turns up with the same reference:
 * its events are set aside and the managers are told.
 */
async function resolveOrder(ctx: Ctx, api: PylonApi | null, ev: ParsedEvent): Promise<string> {
  if (ev.projectId) {
    const linked = await ctx.db.order.findFirst({ where: { pylonProjectId: ev.projectId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (linked) return linked.id;
  }
  let reference = ev.reference;
  // Most events say which reference their project carries, even when it is empty, and a busy
  // Pylon account sends hundreds a day for projects that have nothing to do with the CRM.
  // Pylon is only asked when the event does not say (a signature, a payment).
  if (!reference && !ev.referenceKnown && ev.projectId && api) reference = (await api.getSolarProject(ev.projectId)).referenceNumber;
  reference = reference ? reference.trim().toUpperCase() : null;
  if (reference) {
    const order = await ctx.db.order.findUnique({ where: { orderNo: reference }, select: { id: true, orderNo: true, customerId: true, pylonProjectId: true } });
    if (order) {
      if (ev.projectId && order.pylonProjectId && order.pylonProjectId !== ev.projectId) await settleProjectConflict(ctx, api, order, ev.projectId);
      return order.id;
    }
  }
  throw new Skip(reference ? `No CRM order has the number “${reference}”.` : 'This Pylon project is not linked to a CRM order (it has no CRM order number as its reference).');
}

/**
 * A second Pylon project claims an order that is linked to another one. If the first project no
 * longer exists in Pylon (deleted and made again), the new one takes over. Otherwise the event is
 * set aside; a manager can unlink the order from its project if the change is intended.
 */
async function settleProjectConflict(ctx: Ctx, api: PylonApi | null, order: { id: string; orderNo: string; customerId: string; pylonProjectId: string | null }, claimant: string): Promise<void> {
  if (api && order.pylonProjectId) {
    try {
      await api.getSolarProject(order.pylonProjectId);
    } catch (e) {
      if (e instanceof PylonApiError && e.status === 404) return; // the old project is gone: let the new one link
      throw e;
    }
  }
  const told = await ctx.db.auditLog.findFirst({ where: { action: 'order.pylon_conflict', entityType: 'Order', entityId: order.id, summary: { contains: claimant } }, select: { id: true } });
  if (!told) {
    await audit(ctx.db, ctx, {
      action: 'order.pylon_conflict',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: Pylon project ${claimant} uses this order number, but the order is linked to project ${order.pylonProjectId}`,
      meta: { linkedProjectId: order.pylonProjectId, claimingProjectId: claimant },
    });
    await notifyUsers(ctx.db, ctx, await managerIds(ctx.db), {
      type: 'pylon.conflict',
      title: `${order.orderNo}: a second Pylon project uses this order number`,
      body: `The order is linked to Pylon project ${order.pylonProjectId}. Project ${claimant} carries the same reference, so what happens in it is not being applied to the order. If the project was replaced on purpose, unlink the order from Pylon on its "Quote, contract & deposit" tab.`,
      href: `${orderHref(order.id)}?tab=deal`,
      orderId: order.id,
    });
  }
  throw new Skip(`Pylon project ${claimant} uses the reference ${order.orderNo}, which is linked to project ${order.pylonProjectId}. Its events are not applied.`, order.id);
}

/**
 * Ties the order to a Pylon project: on the order, on the timeline and in the audit log. Events of
 * that project which arrived while nobody knew its order get their turn. Returns false when the
 * order was linked to this project already.
 */
async function writeProjectLink(ctx: Ctx, orderId: string, projectId: string, url: string | null): Promise<boolean> {
  const order = await ctx.db.order.findUniqueOrThrow({ where: { id: orderId }, select: { pylonProjectId: true, pylonProjectUrl: true, orderNo: true, customerId: true } });
  const safeUrl = url && /^https:\/\//.test(url) ? url : null;
  if (order.pylonProjectId === projectId) {
    if (!order.pylonProjectUrl && safeUrl) await ctx.db.order.update({ where: { id: orderId }, data: { pylonProjectUrl: safeUrl } });
    return false;
  }
  await ctx.db.order.update({ where: { id: orderId }, data: { pylonProjectId: projectId, pylonProjectUrl: safeUrl ?? pylonProjectUrl(projectId), pylonSyncedAt: null } });
  // On the timeline too, so the salesperson sees it if somebody else started the project.
  await addActivity(ctx.db, ctx, { customerId: order.customerId, orderId, type: 'SYSTEM', summary: 'Linked to a project in Pylon', payload: { pylonProjectId: projectId, previous: order.pylonProjectId } });
  await audit(ctx.db, ctx, {
    action: 'order.pylon_link',
    entityType: 'Order',
    entityId: orderId,
    orderId,
    customerId: order.customerId,
    summary: `${order.orderNo}: linked to Pylon project ${projectId}`,
    before: { pylonProjectId: order.pylonProjectId },
    after: { pylonProjectId: projectId },
  });
  // Events of this project that arrived while nobody knew which order it belonged to get their turn now.
  await ctx.db.pylonEvent.updateMany({
    where: { status: 'IGNORED', orderId: null, payload: { path: ['relationships', 'solar_project', 'data', 'id'], equals: projectId } },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: nowOf(ctx), processedAt: null },
  });
  return true;
}

/**
 * Remembers which Pylon project an event's order belongs to. A project that has just been
 * linked, or whose first full read failed, is read in full: the event that revealed the link
 * says nothing about the designs made before it.
 */
async function linkProject(ctx: Ctx, api: PylonApi | null, orderId: string, ev: ParsedEvent): Promise<void> {
  if (!ev.projectId) return;
  await writeProjectLink(ctx, orderId, ev.projectId, str(ev.attributes.project_in_app_url));
  if (!api) return;
  const order = await ctx.db.order.findUniqueOrThrow({ where: { id: orderId }, select: { pylonProjectId: true, pylonSyncedAt: true } });
  if (order.pylonProjectId === ev.projectId && !order.pylonSyncedAt) await syncPylonProject(ctx, api, orderId);
}

function needApi(api: PylonApi | null): PylonApi {
  if (!api) throw new PylonApiError('The Pylon API token is not configured.', null, true);
  return api;
}

function quoteData(design: PylonDesign) {
  const kw = design.dcOutputKw;
  const kwh = design.storageKwh;
  const size = [kw ? `${kw} kW solar` : '', kwh ? `${kwh} kWh battery` : ''].filter(Boolean).join(' with ');
  return {
    pylonDesignId: design.id,
    // The size, then the name the designer gave this option in Pylon.
    title: [size, design.title && design.title !== size ? design.title : ''].filter(Boolean).join(' · ').slice(0, 200),
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
  await linkProject(ctx, api, orderId, ev);
  if (ev.name !== 'solar_projects.updated' || !api || !ev.projectId) return { status: 'PROCESSED', note: 'Project linked.', orderId };

  const project = await api.getSolarProject(ev.projectId);
  // Signed on the web: the signed copy is archived. That normally happens through its own event;
  // doing it here as well covers the case where that event was missed.
  if (project.hasEsignature) {
    const applied = await archiveSignatureIfMissing(ctx, api, orderId, project);
    return { status: 'PROCESSED', note: applied ?? 'Project linked.', orderId };
  }
  // Marked as sold in Pylon by hand, without a contract in the CRM: nudge the salesperson once.
  if (!project.manuallySold) return { status: 'PROCESSED', note: 'Project linked.', orderId };
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
    return { status: 'PROCESSED' as const, note: 'Project marked as sold in Pylon; asked sales to archive the contract.', orderId };
  });
}

async function handleDesign(ctx: Ctx, api: PylonApi | null, ev: ParsedEvent): Promise<Handled> {
  if (!ev.designId) throw new Skip('The event does not say which design it is about.');
  const orderId = await resolveOrder(ctx, api, ev);
  await linkProject(ctx, api, orderId, ev);
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
  await linkProject(ctx, api, orderId, ev);
  return applySigned(ctx, api, orderId, ev);
}

/** The customer signed: quote, signed copy and contract for an order that is already known. */
async function applySigned(ctx: Ctx, api: PylonApi | null, orderId: string, ev: ParsedEvent): Promise<Handled> {
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
    const outcome = await inTx(ctx.db, async (tx): Promise<{ note: string; documents: Document[]; declined?: boolean }> => {
      const order = await lockedOrder(tx, orderId);
      const tell = order.ownerId ? [order.ownerId] : await managerIds(tx);

      // A customer can sign an old proposal after the order was lost, cancelled or handed to
      // operations. Nothing is changed then, but it must not pass unnoticed: it goes on the
      // timeline and to the people who can act on it.
      const blocked = editBlockReason(order);
      if (blocked) {
        const closed = order.sideState === 'LOST' || order.sideState === 'CANCELLED';
        await addActivity(tx, ctx, { customerId: order.customerId, orderId, type: 'SYSTEM', summary: 'The customer signed the proposal in Pylon. Nothing was changed here', body: blocked, occurredAt: signedAt });
        await notifyUsers(tx, ctx, closed ? [order.ownerId, ...(await managerIds(tx))] : tell, {
          type: 'pylon.signed_not_applied',
          title: `${order.orderNo}: the customer signed in Pylon, but the order is ${order.sideState === 'LOST' ? 'marked as lost' : order.sideState === 'CANCELLED' ? 'cancelled' : 'already with operations'}`,
          body: `${blocked}\nNothing was changed. The signed copy can be downloaded from the project in Pylon.`,
          href: orderHref(orderId),
          orderId,
        });
        return { note: `Signed in Pylon, but not applied: ${blocked} The people concerned were told.`, documents: [], declined: true };
      }

      const quote = await upsertPylonQuote(tx, ctx, order, quoteData(design));
      // Signing a web proposal means the customer has seen it.
      await markQuoteSentInTx(tx, ctx, order, quote.quoteId, { sentAt: signedAt, via: 'PYLON' });
      const live = await tx.contract.findFirst({ where: { orderId, voidedAt: null }, select: { id: true, quoteId: true } });
      if (live) {
        if (live.quoteId === quote.quoteId) return { note: 'Signed in Pylon. The contract on file is for the same version, so nothing was changed.', documents: [] };
        // A different version from the one under contract. Which one counts is for a person to
        // decide; the signed copy is kept (its link expires within the hour) and sales is asked.
        const fresh = (await loadOrderState(tx, orderId))!;
        const kept: Document[] = [];
        if (staged) {
          const other = await tx.documentType.findUniqueOrThrow({ where: { key: 'other' } });
          kept.push(await attachStaged(tx, ctx, fresh, staged, { type: other, source: 'PYLON', note: 'Signed in Pylon while a contract for another version was on file' }));
        }
        const now = nowOf(ctx);
        if (!(await tx.task.findFirst({ where: { orderId, kind: 'PYLON_RESIGNED', status: 'OPEN' }, select: { id: true } }))) {
          await tx.task.create({
            data: { id: newId('tsk'), orderId, assigneeId: order.ownerId, title: 'The customer signed a different version in Pylon: check which contract applies', dueAt: now, kind: 'PYLON_RESIGNED', remindedAt: now, createdAt: now },
          });
        }
        await notifyUsers(tx, ctx, tell, {
          type: 'pylon.signed_other_version',
          title: `${order.orderNo}: the customer signed a different version in Pylon`,
          body: `A contract for another quote version is already archived. ${kept.length ? 'The newly signed copy has been saved under Other documents.' : 'Pylon did not provide the signed copy.'} If the new version is the agreement, replace the contract.`,
          href: `${orderHref(orderId)}?tab=deal`,
          orderId,
        });
        return { note: 'Signed in Pylon for a different version than the contract on file; sales was asked to check.', documents: kept };
      }
      if (!staged) {
        const now = nowOf(ctx);
        if (!(await tx.task.findFirst({ where: { orderId, kind: 'PYLON_ACCEPTED', status: 'OPEN' }, select: { id: true } }))) {
          await tx.task.create({
            data: { id: newId('tsk'), orderId, assigneeId: order.ownerId, title: 'The customer accepted the Pylon proposal: archive the signed copy', dueAt: now, kind: 'PYLON_ACCEPTED', remindedAt: now, createdAt: now },
          });
        }
        await notifyUsers(tx, ctx, tell, {
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
      await notifyUsers(tx, ctx, tell, {
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
    return { status: outcome.declined ? 'IGNORED' : 'PROCESSED', note: outcome.note, orderId };
  } catch (e) {
    if (staged) await cleanupStaged(staged);
    throw e;
  }
}

async function handlePayment(ctx: Ctx, api: PylonApi | null, ev: ParsedEvent, row: PylonEvent): Promise<Handled> {
  const orderId = await resolveOrder(ctx, api, ev);
  await linkProject(ctx, api, orderId, ev);
  const amount = typeof ev.attributes.amount === 'number' ? Math.round(ev.attributes.amount) : null;
  if (!amount || amount <= 0) throw new Skip('The payment event carries no amount.', orderId);
  const currency = (str(ev.attributes.currency) ?? 'AUD').toUpperCase();
  const receipt = str(ev.attributes.receipt_url);
  const purpose = (str(ev.attributes.purpose) ?? 'deposit').toLowerCase();
  const what = `${formatCents(amount, currency)} (${purpose})`;
  const outcome = await inTx(ctx.db, async (tx) => {
    const order = await lockedOrder(tx, orderId);
    // Money that arrives for a closed order is exactly the kind of thing nobody may miss.
    if (order.sideState === 'LOST' || order.sideState === 'CANCELLED') {
      const state = order.sideState === 'LOST' ? 'marked as lost' : 'cancelled';
      await addActivity(tx, ctx, { customerId: order.customerId, orderId, type: 'DEPOSIT', summary: `Pylon gateway payment of ${what} received, but the order is ${state}`, body: 'No deposit was recorded. Check whether the money has to be refunded.', payload: { pylonEventId: row.pylonEventId, receiptUrl: receipt } });
      await notifyUsers(tx, ctx, [order.ownerId, ...(await managerIds(tx))], {
        type: 'pylon.payment_not_applied',
        title: `${order.orderNo}: a payment of ${formatCents(amount, currency)} arrived through Pylon, but the order is ${state}`,
        body: 'No deposit was recorded. Check with the customer and with finance whether it has to be refunded.',
        href: orderHref(orderId),
        orderId,
      });
      await notifyRoles(tx, ctx, ['FINANCE'], {
        type: 'pylon.payment_not_applied',
        title: `Payment of ${formatCents(amount, currency)} through Pylon for ${order.orderNo}, which is ${state}`,
        body: 'No deposit was recorded in the CRM. A refund may be due.',
        href: '/finance',
      });
      return 'closed' as const;
    }
    // Only a deposit moves the sale forward. Other payments (a balance, an extra) are noted for whoever looks at the order.
    if (purpose !== 'deposit') {
      await addActivity(tx, ctx, { customerId: order.customerId, orderId, type: 'DEPOSIT', summary: `Pylon gateway payment of ${what} received`, body: 'Not a deposit, so nothing else was changed.', payload: { pylonEventId: row.pylonEventId, receiptUrl: receipt } });
      return 'noted' as const;
    }
    return createGatewayDeposit(tx, ctx, order, { amountCents: amount, currency, receiptUrl: receipt && /^https:\/\//.test(receipt) ? receipt : null, pylonEventId: row.pylonEventId });
  });
  if (outcome === 'closed') return { status: 'IGNORED', note: `Gateway payment of ${what} arrived for a closed order. No deposit was recorded; sales, managers and finance were told.`, orderId };
  return {
    status: 'PROCESSED',
    note:
      outcome === 'created'
        ? `Gateway payment of ${what} recorded as a deposit awaiting finance.`
        : outcome === 'deposit_exists'
          ? `Gateway payment of ${what} noted; a deposit was already on record.`
          : outcome === 'noted'
            ? `Gateway payment of ${what} noted on the timeline (not a deposit).`
            : 'Already recorded.',
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
          // Given up on. Without this nobody would know until they happened to open the Pylon page.
          await notifyRoles(ctx.db, ctx, ['ADMIN'], {
            type: 'pylon.event_failed',
            title: `A Pylon event could not be processed: ${row.name}`,
            body: `${message.slice(0, 300)}\nOpen Administration > Pylon to look at it and try again.`,
            href: '/settings/pylon',
          });
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
 * The signed proposal of a project is archived as the contract when the order has none yet.
 * Used where there is no "signed" event to act on: a project update, or a full read of the
 * project. Returns what was done, or null when there was nothing to do.
 */
async function archiveSignatureIfMissing(ctx: Ctx, api: PylonApi, orderId: string, project: PylonProject): Promise<string | null> {
  if (!project.hasEsignature) return null;
  const order = await loadOrderState(ctx.db, orderId);
  if (!order || editBlockReason(order)) return null;
  if (await ctx.db.contract.findFirst({ where: { orderId, voidedAt: null }, select: { id: true } })) return null;
  try {
    const handled = await applySigned(ctx, api, orderId, {
      name: 'web_proposals.signed',
      attributes: {},
      projectId: project.id,
      designId: project.latestSignedDesignId,
      reference: project.referenceNumber,
      referenceKnown: true,
      createdAt: null,
    });
    return handled.note;
  } catch (e) {
    // Understood, but not something that can be applied (Pylon does not say which design).
    if (e instanceof Skip) return e.note;
    throw e;
  }
}

export interface PylonSyncResult {
  /** Designs of the project that carry a size or a price. */
  designs: number;
  /** Quote versions created or changed by this read. */
  quotesChanged: number;
  /** What happened about the signature, if anything. */
  signature: string | null;
  /** Property fields that were empty and are now filled from Pylon. */
  filled: string[];
}

/** No project has this many options; a cap keeps one odd project from flooding the API. */
const MAX_DESIGNS_PER_SYNC = 30;

/**
 * Reads the order's Pylon project in full and brings the order up to date with it: one quote
 * version per design, the signed proposal as the contract if there is none, and the site details
 * Pylon knows for property fields that are still empty. Reading twice changes nothing twice.
 */
export async function syncPylonProject(ctx: Ctx, api: PylonApi, orderId: string): Promise<PylonSyncResult> {
  const linked = await ctx.db.order.findUniqueOrThrow({ where: { id: orderId }, select: { pylonProjectId: true } });
  if (!linked.pylonProjectId) throw new ValidationError('This order is not linked to a project in Pylon.');
  let project: PylonProject;
  try {
    project = await api.getSolarProject(linked.pylonProjectId);
  } catch (e) {
    if (e instanceof PylonApiError && e.status === 404) throw new PylonApiError('The project this order is linked to no longer exists in Pylon. A manager can unlink it.', 404, false);
    throw e;
  }
  const result: PylonSyncResult = { designs: 0, quotesChanged: 0, signature: null, filled: [] };

  for (const designId of project.designIds.slice(-MAX_DESIGNS_PER_SYNC)) {
    let design: PylonDesign;
    try {
      design = await api.getSolarDesign(designId);
    } catch (e) {
      if (e instanceof PylonApiError && e.status === 404) continue; // deleted while we were reading
      throw e;
    }
    if (design.totalCents === null && design.dcOutputKw === null && design.storageKwh === null) continue;
    result.designs++;
    const outcome = await inTx(ctx.db, async (tx) => {
      const order = await lockedOrder(tx, orderId);
      // A closed order, or one that operations has, keeps the quotes it had.
      if (editBlockReason(order)) return null;
      return (await upsertPylonQuote(tx, ctx, order, quoteData(design))).outcome;
    });
    if (outcome && outcome !== 'unchanged') result.quotesChanged++;
  }

  result.signature = await archiveSignatureIfMissing(ctx, api, orderId, project);

  result.filled = await inTx(ctx.db, async (tx) => {
    const order = await lockedOrder(tx, orderId);
    if (editBlockReason(order)) return [];
    const property = await tx.property.findUniqueOrThrow({ where: { id: order.propertyId } });
    const nmi = (project.site.nmi ?? '').replace(/\s+/g, '').toUpperCase();
    const fill: { nmi?: string; retailer?: string; phase?: string } = {};
    if (!property.nmi && /^[A-Z0-9]{10,11}$/.test(nmi)) fill.nmi = nmi;
    if (!property.retailer && project.site.retailer) fill.retailer = project.site.retailer.trim().slice(0, 100);
    if (!property.phase && project.site.phases) fill.phase = project.site.phases === 'one' ? 'Single phase' : 'Three phase';
    const fields = Object.keys(fill);
    if (!fields.length) return [];
    await tx.property.update({ where: { id: property.id }, data: fill });
    await audit(tx, ctx, {
      action: 'property.update',
      entityType: 'Property',
      entityId: property.id,
      orderId,
      customerId: order.customerId,
      summary: `${order.orderNo}: property details filled in from Pylon (${fields.join(', ')})`,
      before: Object.fromEntries(fields.map((f) => [f, ''])),
      after: fill,
      meta: { source: 'pylon', pylonProjectId: project.id },
    });
    return fields;
  });

  await ctx.db.order.update({ where: { id: orderId }, data: { pylonSyncedAt: nowOf(ctx) } });
  return result;
}

export interface PylonProjectPreview {
  projectId: string;
  url: string;
  customerName: string | null;
  siteAddress: string | null;
  designs: number;
  signed: boolean;
  reference: string | null;
}

async function projectForLinking(ctx: Ctx, api: PylonApi | null, input: { orderId: string; ref: string }): Promise<PylonProject> {
  const order = await requireEditableOrder(ctx, input.orderId);
  const pylon = needApi(api);
  const projectId = parsePylonProjectRef(input.ref);
  if (!projectId) throw new ValidationError('That is not a Pylon project.', { ref: 'Paste the address of the project in Pylon, for example https://app.getpylon.com/library/…' });
  const current = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id }, select: { pylonProjectId: true } });
  if (current.pylonProjectId && current.pylonProjectId !== projectId) {
    throw new ConflictError('This order is already linked to another project in Pylon. A manager can unlink it first.');
  }
  // One project, one order: what the customer signs or pays there can only belong to one sale.
  const other = await ctx.db.order.findFirst({ where: { pylonProjectId: projectId, id: { not: order.id } }, select: { orderNo: true } });
  if (other) {
    const manager = ctx.actor.kind === 'user' && isManager(ctx.actor);
    throw new ConflictError(manager ? `That Pylon project is already linked to order ${other.orderNo}. Unlink it there first.` : 'That Pylon project is already linked to another order. Please ask your manager.');
  }
  try {
    return await pylon.getSolarProject(projectId);
  } catch (e) {
    if (e instanceof PylonApiError && e.status === 404) throw new ValidationError('Pylon has no project with that address.', { ref: 'Check the link and try again.' });
    throw e;
  }
}

/** Shows which project a pasted link leads to, so a person can check before linking. Changes nothing. */
export async function previewPylonProject(ctx: Ctx, api: PylonApi | null, input: { orderId: string; ref: string }): Promise<PylonProjectPreview> {
  const project = await projectForLinking(ctx, api, input);
  return {
    projectId: project.id,
    url: project.inAppUrl,
    customerName: project.customerName,
    siteAddress: project.siteAddress,
    designs: project.designIds.length,
    signed: project.hasEsignature,
    reference: project.referenceNumber,
  };
}

/**
 * Links the order to a project that already exists in Pylon, by its address there, and reads the
 * project in full. For projects started in Pylon without the CRM order number as their reference.
 */
export async function linkPylonProject(ctx: Ctx, api: PylonApi | null, input: { orderId: string; ref: string }): Promise<PylonSyncResult> {
  const project = await projectForLinking(ctx, api, input);
  await writeProjectLink(ctx, input.orderId, project.id, project.inAppUrl);
  return syncPylonProject(ctx, needApi(api), input.orderId);
}

/** Reads the linked project again, on request. Anyone who may work on the order can ask. */
export async function refreshFromPylon(ctx: Ctx, api: PylonApi | null, input: { orderId: string }): Promise<PylonSyncResult> {
  await requireEditableOrder(ctx, input.orderId);
  return syncPylonProject(ctx, needApi(api), input.orderId);
}

// ---------------------------------------------------------------------------
// Reading Pylon's event list
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  /** Pages are read until one holds nothing new and everything on it is older than this. */
  lookbackMs?: number;
  /** A page holds 50 events. */
  maxPages?: number;
}

/**
 * Stores every event of Pylon's own list (kept for 30 days) that we have not seen, reading from
 * the newest backwards. With a webhook configured this catches deliveries that never arrived;
 * without one it is how events get here at all.
 */
export async function reconcilePylonEvents(ctx: Ctx, api: PylonApi, opts: ReconcileOptions = {}): Promise<{ added: number; pages: number }> {
  const lookbackMs = opts.lookbackMs ?? 3 * 24 * 60 * 60 * 1000;
  const maxPages = opts.maxPages ?? 150;
  let added = 0;
  let pages = 0;
  let next: string | null | undefined;
  const horizon = nowOf(ctx).getTime() - lookbackMs;
  do {
    const page = await api.listEvents(next);
    pages++;
    let addedOnPage = 0;
    let oldest = Infinity;
    for (const event of page.events) {
      const created = Date.parse(str(obj(obj(event).attributes).created_at) ?? '');
      if (!Number.isNaN(created)) oldest = Math.min(oldest, created);
      try {
        if (!(await recordPylonEvent(ctx.db, event, nowOf(ctx))).duplicate) addedOnPage++;
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
      }
    }
    added += addedOnPage;
    const withinLookback = oldest !== Infinity && oldest >= horizon;
    next = addedOnPage === 0 && !withinLookback ? null : page.next;
  } while (next && pages < maxPages);
  return { added, pages };
}

const SYNC_STATE_KEY = 'pylonSync';
/** After this many failed reads in a row the administrators are told, once. */
const ALERT_AFTER_FAILURES = 5;

export interface PylonSyncState {
  lastRunAt: string | null;
  lastOkAt: string | null;
  /** When an event we did not have was last found. */
  lastEventAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  alerted: boolean;
}

export async function getPylonSyncState(db: Db): Promise<PylonSyncState | null> {
  const row = await db.setting.findUnique({ where: { key: SYNC_STATE_KEY } });
  return row ? (row.value as unknown as PylonSyncState) : null;
}

/**
 * The frequent read of Pylon's event list: every minute, a page or two. It makes the integration
 * work with the API token alone, before any webhook exists, and keeps a record of whether Pylon
 * can be reached so that a revoked token does not go unnoticed.
 */
export async function pollPylonEvents(ctx: Ctx, api: PylonApi): Promise<{ added: number; pages: number; error: string | null }> {
  let outcome = { added: 0, pages: 0, error: null as string | null };
  await withJobLock(ctx.db, 760202, async () => {
    const now = nowOf(ctx);
    const state: PylonSyncState = (await getPylonSyncState(ctx.db)) ?? { lastRunAt: null, lastOkAt: null, lastEventAt: null, lastError: null, consecutiveFailures: 0, alerted: false };
    state.lastRunAt = now.toISOString();
    try {
      // The very first read takes what Pylon has for the last day; after that a short overlap is
      // enough, because an event can show up in the list a minute after its own timestamp.
      const r = await reconcilePylonEvents(ctx, api, state.lastOkAt ? { lookbackMs: 15 * 60_000, maxPages: 20 } : { lookbackMs: 24 * 60 * 60_000, maxPages: 40 });
      outcome = { ...r, error: null };
      state.lastOkAt = now.toISOString();
      if (r.added > 0) state.lastEventAt = now.toISOString();
      state.lastError = null;
      state.consecutiveFailures = 0;
      state.alerted = false;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      outcome.error = message;
      state.lastError = message.slice(0, 500);
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= ALERT_AFTER_FAILURES && !state.alerted) {
        state.alerted = true;
        await notifyRoles(ctx.db, ctx, ['ADMIN'], {
          type: 'pylon.unreachable',
          title: 'The CRM cannot read from Pylon',
          body: `${message.slice(0, 300)}\nQuotes, signatures and payments from Pylon are not arriving. Check the API token under Administration > Pylon.`,
          href: '/settings/pylon',
        });
      }
    }
    const value = state as unknown as Prisma.InputJsonValue;
    await ctx.db.setting.upsert({ where: { key: SYNC_STATE_KEY }, create: { key: SYNC_STATE_KEY, value }, update: { value } });
    return true;
  });
  return outcome;
}

/**
 * Removes stored events that never concerned a CRM order, once they are older than Pylon's
 * own list. A busy account produces hundreds a day; nothing can be done with them after that.
 */
export async function purgePylonEvents(ctx: Ctx, olderThanDays = 35): Promise<{ removed: number }> {
  const cutoff = new Date(nowOf(ctx).getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const r = await ctx.db.pylonEvent.deleteMany({ where: { status: 'IGNORED', orderId: null, receivedAt: { lt: cutoff } } });
  return { removed: r.count };
}
