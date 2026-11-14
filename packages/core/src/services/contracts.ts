// The signed contract. Whether it arrived by email, was uploaded by hand or was signed on a Pylon
// web proposal, it ends up as one Contract record that points at the archived file. An order does
// not need one: the deposit is what shows that the customer is going ahead.
import type { ContractSource, Document, Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { getConfig } from '../config';
import { formatDateOnly, todayDateOnly } from '../domain';
import { ConflictError, FieldErrors, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit } from './audit';
import { attachStaged, cleanupStaged, finishImage, supersedeDocuments, type StagedFile } from './documents';
import { lockOrderForWork, syncOrderStage, touchStaffActivity, type OrderState } from './orders';
import { markQuoteSentInTx } from './quotes';
import { DOC_TYPE } from './reference';
import { completeSystemTasks } from './timeline';

export interface ArchiveContractInput {
  orderId: string;
  /** The quote version the customer signed. */
  quoteId: string | null;
  signedOn: Date | null;
  /** One or more files; the first is the contract itself, the rest are extra pages. */
  files: StagedFile[];
  source?: ContractSource;
  /** Void the contract already on file and archive this one in its place. */
  replaceExisting?: boolean;
}

/**
 * Archives the signed contract inside the caller's transaction (order lock held). Marks the
 * chosen quote as accepted and records the signing date on the order.
 */
export async function archiveContractInTx(tx: Tx, ctx: Ctx, order: OrderState, input: Omit<ArchiveContractInput, 'orderId'>): Promise<{ id: string; documents: Document[] }> {
  const quote = input.quoteId ? await tx.quote.findFirst({ where: { id: input.quoteId, orderId: order.id } }) : null;
  if (!quote) throw new ValidationError('Choose the quote version the customer signed.', { quoteId: 'Choose a quote version.' });

  const live = await tx.contract.findFirst({ where: { orderId: order.id, voidedAt: null } });
  const now = nowOf(ctx);
  if (live) {
    if (!input.replaceExisting) throw new ConflictError('A signed contract is already archived for this order. Use “Replace contract” to swap it.');
    await tx.contract.update({
      where: { id: live.id },
      data: { voidedAt: now, voidedById: ctx.actor.kind === 'user' ? ctx.actor.id : null, voidReason: 'Replaced by a new contract' },
    });
    // The old files stay on record but stop being the current contract, so the same PDF can come back.
    await supersedeDocuments(tx, ctx, order.id, DOC_TYPE.signedContract);
  }

  // The customer cannot have signed a version nobody sent. If the sending was never recorded,
  // record it now: this freezes the version (a later change in Pylon becomes a new version
  // instead of rewriting what was signed) and keeps "quoted" ahead of "signed" in the figures.
  if (!quote.sentAt) {
    await markQuoteSentInTx(tx, ctx, order, quote.id, { sentAt: input.signedOn, via: input.source === 'PYLON' ? 'PYLON' : 'MANUAL', inferredFromContract: true });
  }

  const type = await tx.documentType.findUniqueOrThrow({ where: { key: DOC_TYPE.signedContract } });
  const documents: Document[] = [];
  for (const file of input.files) {
    documents.push(await attachStaged(tx, ctx, order, file, { type, source: input.source === 'PYLON' ? 'PYLON' : 'UPLOAD' }));
  }
  const id = newId('con');
  await tx.contract.create({
    data: {
      id,
      orderId: order.id,
      quoteId: quote.id,
      documentId: documents[0]!.id,
      signedOn: input.signedOn!,
      source: input.source ?? 'UPLOAD',
      createdById: ctx.actor.kind === 'user' ? ctx.actor.id : null,
      createdAt: now,
    },
  });
  await tx.quote.updateMany({ where: { orderId: order.id, isAccepted: true, id: { not: quote.id } }, data: { isAccepted: false } });
  await tx.quote.update({ where: { id: quote.id }, data: { isAccepted: true } });
  await tx.order.update({ where: { id: order.id }, data: { signedAt: input.signedOn! } });

  const summary = `Signed contract ${live ? 'replaced' : 'archived'} (signed ${formatDateOnly(input.signedOn)}, quote v${quote.version})`;
  await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'CONTRACT', summary, payload: { contractId: id, quoteId: quote.id } });
  await touchStaffActivity(tx, ctx, order);
  await syncOrderStage(tx, ctx, order.id);
  await audit(tx, ctx, {
    action: live ? 'contract.replace' : 'contract.archive',
    entityType: 'Contract',
    entityId: id,
    orderId: order.id,
    customerId: order.customerId,
    summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
    before: live ? { contractId: live.id, documentId: live.documentId } : undefined,
    after: { quoteId: quote.id, quoteVersion: quote.version, signedOn: input.signedOn, source: input.source ?? 'UPLOAD', documentIds: documents.map((d) => d.id) },
  });
  return { id, documents };
}

export async function archiveContract(ctx: Ctx, input: ArchiveContractInput): Promise<{ id: string }> {
  try {
    const errors = new FieldErrors();
    if (input.files.length === 0) errors.add('files', 'Attach the signed contract.');
    if (!input.signedOn) errors.add('signedOn', 'Enter the date the customer signed.');
    else if (input.signedOn > todayDateOnly(nowOf(ctx), getConfig().timeZone)) errors.add('signedOn', 'The signing date cannot be in the future.');
    if (!input.quoteId) errors.add('quoteId', 'Choose the quote version the customer signed.');
    errors.throwIfAny();

    const result = await inTx(ctx.db, async (tx) => {
      const order = await lockOrderForWork(tx, ctx, input.orderId);
      return archiveContractInTx(tx, ctx, order, input);
    });
    for (const doc of result.documents) await finishImage(ctx, doc);
    return { id: result.id };
  } catch (e) {
    await cleanupStaged(input.files);
    throw e;
  }
}

/**
 * Removes the signed copy from the order. The file stays in the folder history, and the stage is
 * untouched: a contract is a file for the folder, not a step.
 */
export async function voidContract(ctx: Ctx, input: { contractId: string; reason: string }): Promise<void> {
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new ValidationError('Say why the contract is being removed.', { reason: 'Give a reason.' });
  const found = await ctx.db.contract.findUnique({ where: { id: input.contractId }, select: { orderId: true } });
  if (!found) throw new NotFoundError('Contract not found.');
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForWork(tx, ctx, found.orderId, 'Contract');
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: input.contractId } });
    if (contract.voidedAt) return;
    const now = nowOf(ctx);
    await tx.contract.update({
      where: { id: contract.id },
      data: { voidedAt: now, voidedById: ctx.actor.kind === 'user' ? ctx.actor.id : null, voidReason: reason },
    });
    await supersedeDocuments(tx, ctx, order.id, DOC_TYPE.signedContract);
    // The signed copy said which version the customer accepted. A deposit on record says so too, and stands.
    if (order.deposit === 'NONE') await tx.quote.updateMany({ where: { orderId: order.id, isAccepted: true }, data: { isAccepted: false } });
    await tx.order.update({ where: { id: order.id }, data: { signedAt: null } });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'CONTRACT', summary: 'Signed contract removed', body: reason });
    await touchStaffActivity(tx, ctx, order);
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'contract.void',
      entityType: 'Contract',
      entityId: contract.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: signed contract removed`,
      before: { documentId: contract.documentId, quoteId: contract.quoteId, signedOn: contract.signedOn },
      after: { voidReason: reason },
    });
  });
}
