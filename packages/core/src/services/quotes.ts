// Quote versions. Designs always come from Pylon, but a quote only counts as "sent" once it has
// actually gone to the customer.
import type { Document, Quote, QuoteSentVia, Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { formatCents, formatKw, formatKwh, isManager } from '../domain';
import { ConflictError, FieldErrors, ForbiddenError, NotFoundError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit, diff } from './audit';
import { attachStaged, cleanupStaged, finishImage, type StagedFile } from './documents';
import { lockOrderForEdit, lockOrderForStaff, requireEditableOrder, syncOrderStage, touchStaffActivity, type OrderState } from './orders';
import { DOC_TYPE } from './reference';

export interface QuoteFields {
  title: string;
  /** Rated DC output in watts. */
  dcWatts: number | null;
  /** Battery storage in watt-hours. */
  storageWh: number | null;
  totalCents: number | null;
  depositCents: number | null;
  notes: string;
}

function describe(q: Pick<Quote, 'version' | 'dcWatts' | 'storageWh' | 'totalCents'>): string {
  const parts = [formatKw(q.dcWatts), q.storageWh ? `${formatKwh(q.storageWh)} battery` : '', formatCents(q.totalCents)].filter(Boolean);
  return `Quote v${q.version}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

function validate(f: QuoteFields): void {
  const errors = new FieldErrors();
  if (f.title.length > 200) errors.add('title', 'Use at most 200 characters.');
  if (f.totalCents === null) errors.add('total', 'Enter the total price.');
  else if (f.totalCents <= 0) errors.add('total', 'The total price must be greater than zero.');
  if (f.depositCents !== null && f.totalCents !== null && f.depositCents > f.totalCents) {
    errors.add('deposit', 'The deposit cannot be more than the total price.');
  }
  if (f.dcWatts !== null && f.dcWatts <= 0) errors.add('systemKw', 'Enter a system size greater than zero, or leave it empty.');
  if (f.storageWh !== null && f.storageWh < 0) errors.add('batteryKwh', 'Enter zero or more.');
  if (f.dcWatts === null && f.storageWh === null) errors.add('systemKw', 'Enter the system size, the battery size, or both.');
  errors.throwIfAny();
}

async function nextVersion(tx: Tx, orderId: string): Promise<number> {
  const last = await tx.quote.findFirst({ where: { orderId }, orderBy: { version: 'desc' }, select: { version: true } });
  return (last?.version ?? 0) + 1;
}

/** Records a new quote version by hand, optionally with the file that goes to the customer. */
export async function createQuote(ctx: Ctx, input: { orderId: string; file?: StagedFile | null } & QuoteFields): Promise<{ id: string; version: number }> {
  try {
    validate(input);
    const result = await inTx(ctx.db, async (tx) => {
      const order = await lockOrderForEdit(tx, ctx, input.orderId);
      const version = await nextVersion(tx, order.id);
      const quoteType = await tx.documentType.findUniqueOrThrow({ where: { key: DOC_TYPE.quote } });
      const doc = input.file ? await attachStaged(tx, ctx, order, input.file, { type: quoteType, note: `Quote v${version}` }) : null;
      const id = newId('quo');
      const quote = await tx.quote.create({
        data: {
          id,
          orderId: order.id,
          version,
          title: input.title.trim(),
          dcWatts: input.dcWatts,
          storageWh: input.storageWh,
          totalCents: input.totalCents,
          depositCents: input.depositCents,
          documentId: doc?.id ?? null,
          notes: input.notes.trim().slice(0, 2000),
          createdById: ctx.actor.kind === 'user' ? ctx.actor.id : null,
          createdAt: nowOf(ctx),
        },
      });
      await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'QUOTE', summary: `${describe(quote)} recorded`, payload: { quoteId: id } });
      await touchStaffActivity(tx, ctx, order);
      await audit(tx, ctx, {
        action: 'quote.create',
        entityType: 'Quote',
        entityId: id,
        orderId: order.id,
        customerId: order.customerId,
        summary: `${order.orderNo}: ${describe(quote)} recorded`,
        after: { version, title: quote.title, dcWatts: quote.dcWatts, storageWh: quote.storageWh, totalCents: quote.totalCents, depositCents: quote.depositCents, documentId: quote.documentId },
      });
      return { id, version, doc };
    });
    if (result.doc) await finishImage(ctx, result.doc);
    return { id: result.id, version: result.version };
  } catch (e) {
    if (input.file) await cleanupStaged(input.file);
    throw e;
  }
}

async function loadQuote(ctx: Ctx, quoteId: string): Promise<Quote> {
  const quote = await ctx.db.quote.findUnique({ where: { id: quoteId } });
  if (!quote) throw new NotFoundError('Quote not found.');
  return quote;
}

/** Gate for the "mark as sent" endpoint, which may carry a file: see requireEditableOrder. */
export async function requireEditableQuote(ctx: Ctx, quoteId: string): Promise<void> {
  const quote = await loadQuote(ctx, quoteId);
  await requireEditableOrder(ctx, quote.orderId, 'Quote');
}

/** Edits a version that has not gone to the customer yet. Sent versions are history: add a new one. */
export async function updateQuote(ctx: Ctx, input: { quoteId: string } & QuoteFields): Promise<void> {
  validate(input);
  const found = await loadQuote(ctx, input.quoteId);
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, found.orderId, 'Quote');
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: found.id } });
    if (quote.sentAt || quote.isAccepted) throw new ConflictError('This version has already gone to the customer. Add a new version instead.');
    const next = {
      title: input.title.trim(),
      dcWatts: input.dcWatts,
      storageWh: input.storageWh,
      totalCents: input.totalCents,
      depositCents: input.depositCents,
      notes: input.notes.trim().slice(0, 2000),
    };
    const change = diff(quote as unknown as Record<string, unknown>, next);
    if (!change) return;
    await tx.quote.update({ where: { id: quote.id }, data: next });
    await touchStaffActivity(tx, ctx, order);
    await audit(tx, ctx, {
      action: 'quote.update',
      entityType: 'Quote',
      entityId: quote.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: updated quote v${quote.version}`,
      ...change,
    });
  });
}

export interface MarkSentOptions {
  sentAt?: Date | null;
  via: QuoteSentVia;
  /** The file that actually went to the customer, typically the quote pages cut from the Pylon proposal. */
  file?: StagedFile | null;
  /** Set when nobody recorded the sending and it is inferred from the customer having signed this version. */
  inferredFromContract?: boolean;
}

/**
 * Records that a version went to the customer, inside the caller's transaction (order lock held).
 * This is what moves an order to "Quoted". Returns the attached document, if a file was given.
 */
export async function markQuoteSentInTx(tx: Tx, ctx: Ctx, order: OrderState, quoteId: string, opts: MarkSentOptions): Promise<Document | null> {
  const quote = await tx.quote.findFirst({ where: { id: quoteId, orderId: order.id } });
  if (!quote) throw new NotFoundError('Quote not found.');
  if (quote.sentAt) return null;
  const now = nowOf(ctx);
  const sentAt = opts.sentAt && opts.sentAt <= now ? opts.sentAt : now;

  let doc: Document | null = null;
  if (opts.file) {
    const quoteType = await tx.documentType.findUniqueOrThrow({ where: { key: DOC_TYPE.quote } });
    const current = quote.documentId ? await tx.document.findUnique({ where: { id: quote.documentId } }) : null;
    doc = await attachStaged(tx, ctx, order, opts.file, { type: quoteType, note: `Quote v${quote.version} as sent`, replaces: current });
  }
  await tx.quote.update({ where: { id: quote.id }, data: { sentAt, sentVia: opts.via, ...(doc ? { documentId: doc.id } : {}) } });
  if (!order.quotedAt || sentAt < order.quotedAt) await tx.order.update({ where: { id: order.id }, data: { quotedAt: sentAt } });
  await addActivity(tx, ctx, {
    customerId: order.customerId,
    orderId: order.id,
    type: 'QUOTE',
    summary: opts.inferredFromContract
      ? `${describe(quote)} recorded as sent: the customer signed this version`
      : `${describe(quote)} sent to the customer${opts.via === 'PYLON' ? ' as a Pylon web proposal' : ''}`,
    occurredAt: sentAt,
    payload: { quoteId: quote.id },
  });
  await touchStaffActivity(tx, ctx, order);
  await syncOrderStage(tx, ctx, order.id);
  await audit(tx, ctx, {
    action: 'quote.sent',
    entityType: 'Quote',
    entityId: quote.id,
    orderId: order.id,
    customerId: order.customerId,
    summary: `${order.orderNo}: quote v${quote.version} marked as sent`,
    after: { sentAt, sentVia: opts.via, documentId: doc?.id },
  });
  return doc;
}

export async function markQuoteSent(ctx: Ctx, input: { quoteId: string; sentAt?: Date | null; file?: StagedFile | null }): Promise<void> {
  try {
    const found = await loadQuote(ctx, input.quoteId);
    const doc = await inTx(ctx.db, async (tx) => {
      const order = await lockOrderForEdit(tx, ctx, found.orderId, 'Quote');
      // Said out loud rather than ignored: a file sent along would otherwise vanish without a word.
      const current = await tx.quote.findUniqueOrThrow({ where: { id: found.id }, select: { sentAt: true } });
      if (current.sentAt) throw new ConflictError('This version is already marked as sent.');
      return markQuoteSentInTx(tx, ctx, order, found.id, { sentAt: input.sentAt, via: 'MANUAL', file: input.file });
    });
    if (doc) await finishImage(ctx, doc);
  } catch (e) {
    if (input.file) await cleanupStaged(input.file);
    throw e;
  }
}

/** Removes a version that never went to the customer. */
export async function deleteQuote(ctx: Ctx, input: { quoteId: string }): Promise<void> {
  const found = await loadQuote(ctx, input.quoteId);
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, found.orderId, 'Quote');
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: found.id }, include: { contracts: { select: { id: true } } } });
    if (quote.sentAt || quote.isAccepted || quote.contracts.length > 0) {
      throw new ConflictError('This version has gone to the customer or is referenced by a contract, so it is kept as history.');
    }
    await tx.quote.delete({ where: { id: quote.id } });
    if (quote.documentId) {
      await tx.document.update({ where: { id: quote.documentId }, data: { deletedAt: nowOf(ctx), deletedById: ctx.actor.kind === 'user' ? ctx.actor.id : null } });
    }
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'QUOTE', summary: `Quote v${quote.version} deleted` });
    await touchStaffActivity(tx, ctx, order);
    await audit(tx, ctx, {
      action: 'quote.delete',
      entityType: 'Quote',
      entityId: quote.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: deleted quote v${quote.version}`,
      before: { version: quote.version, title: quote.title, dcWatts: quote.dcWatts, storageWh: quote.storageWh, totalCents: quote.totalCents, depositCents: quote.depositCents },
    });
  });
}

// ---------------------------------------------------------------------------
// Pylon
// ---------------------------------------------------------------------------

/**
 * Cuts the tie between an order and its Pylon project. For a manager, when the project was
 * replaced in Pylon on purpose: the next event of the new project (same order number as its
 * reference) links it. Until then a second project claiming the order number is kept out.
 */
export async function unlinkPylonProject(ctx: Ctx, input: { orderId: string }): Promise<void> {
  if (ctx.actor.kind !== 'user' || !isManager(ctx.actor)) throw new ForbiddenError('Only a manager can unlink an order from its Pylon project.');
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { pylonProjectId: true } });
    if (!current.pylonProjectId) return;
    await tx.order.update({ where: { id: order.id }, data: { pylonProjectId: null, pylonProjectUrl: null } });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'SYSTEM', summary: 'Unlinked from its project in Pylon', payload: { pylonProjectId: current.pylonProjectId } });
    await audit(tx, ctx, {
      action: 'order.pylon_unlink',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: unlinked from Pylon project ${current.pylonProjectId}`,
      before: { pylonProjectId: current.pylonProjectId },
      after: { pylonProjectId: null },
    });
  });
}

export interface PylonQuoteData {
  pylonDesignId: string;
  title: string;
  dcWatts: number | null;
  storageWh: number | null;
  totalCents: number | null;
  depositCents: number | null;
  currency: string;
  webProposalUrl: string | null;
}

/**
 * Records what a Pylon design currently says. A version the customer has not seen is updated in
 * place; once a version has been sent, changed figures become a new version so the sent one is
 * preserved. Never changes the order's stage. Must run inside a transaction holding the order lock.
 */
export async function upsertPylonQuote(
  tx: Tx,
  ctx: Ctx,
  order: OrderState,
  data: PylonQuoteData,
  file?: StagedFile | null,
): Promise<{ quoteId: string; outcome: 'created' | 'updated' | 'new_version' | 'unchanged'; documentId: string | null }> {
  const existing = await tx.quote.findFirst({ where: { orderId: order.id, pylonDesignId: data.pylonDesignId }, orderBy: { version: 'desc' } });
  const figures = { dcWatts: data.dcWatts, storageWh: data.storageWh, totalCents: data.totalCents, depositCents: data.depositCents };
  const figuresChanged = existing ? diff(existing as unknown as Record<string, unknown>, figures) !== null : true;
  const quoteType = await tx.documentType.findUniqueOrThrow({ where: { key: DOC_TYPE.quote } });

  if (existing && (existing.sentAt || existing.isAccepted) && !figuresChanged) {
    if (existing.webProposalUrl !== data.webProposalUrl) await tx.quote.update({ where: { id: existing.id }, data: { webProposalUrl: data.webProposalUrl } });
    return { quoteId: existing.id, outcome: 'unchanged', documentId: existing.documentId };
  }

  if (existing && !existing.sentAt && !existing.isAccepted) {
    let documentId = existing.documentId;
    if (file) {
      const current = existing.documentId ? await tx.document.findUnique({ where: { id: existing.documentId } }) : null;
      if (!current || current.sha256 !== file.sha256) {
        const doc = await attachStaged(tx, ctx, order, file, { type: quoteType, source: 'PYLON', note: `Quote v${existing.version} (Pylon)`, replaces: current });
        documentId = doc.id;
      }
    }
    await tx.quote.update({
      where: { id: existing.id },
      data: { ...figures, title: data.title, currency: data.currency, webProposalUrl: data.webProposalUrl, documentId },
    });
    if (figuresChanged) {
      await audit(tx, ctx, {
        action: 'quote.update',
        entityType: 'Quote',
        entityId: existing.id,
        orderId: order.id,
        customerId: order.customerId,
        summary: `${order.orderNo}: quote v${existing.version} updated from Pylon`,
        ...(diff(existing as unknown as Record<string, unknown>, figures) ?? {}),
      });
    }
    return { quoteId: existing.id, outcome: figuresChanged ? 'updated' : 'unchanged', documentId };
  }

  const version = await nextVersion(tx, order.id);
  const doc = file ? await attachStaged(tx, ctx, order, file, { type: quoteType, source: 'PYLON', note: `Quote v${version} (Pylon)` }) : null;
  const id = newId('quo');
  const quote = await tx.quote.create({
    data: {
      id,
      orderId: order.id,
      version,
      title: data.title,
      pylonDesignId: data.pylonDesignId,
      ...figures,
      currency: data.currency,
      webProposalUrl: data.webProposalUrl,
      documentId: doc?.id ?? null,
      createdAt: nowOf(ctx),
    },
  });
  await addActivity(tx, ctx, {
    customerId: order.customerId,
    orderId: order.id,
    type: 'QUOTE',
    summary: `${describe(quote)} received from Pylon`,
    payload: { quoteId: id, pylonDesignId: data.pylonDesignId },
  });
  await audit(tx, ctx, {
    action: 'quote.create',
    entityType: 'Quote',
    entityId: id,
    orderId: order.id,
    customerId: order.customerId,
    summary: `${order.orderNo}: ${describe(quote)} received from Pylon`,
    after: { version, pylonDesignId: data.pylonDesignId, ...figures },
  });
  return { quoteId: id, outcome: existing ? 'new_version' : 'created', documentId: doc?.id ?? null };
}
