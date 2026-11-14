// Deposits. Sales files the proof of payment. That the money has arrived is confirmed by
// operations when they accept the order, and finance is told then.
import type { Deposit, DepositMethod, Document, Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { getConfig } from '../config';
import { formatCents, todayDateOnly } from '../domain';
import { ConflictError, FieldErrors, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit } from './audit';
import { attachStaged, cleanupStaged, finishImage, supersedeDocuments, type StagedFile } from './documents';
import { notifyRoles, notifyUsers } from './notify';
import { lockOrderForWork, orderHref, syncOrderStage, touchStaffActivity, type OrderState } from './orders';
import { acceptQuoteInTx } from './quotes';
import { DOC_TYPE } from './reference';
import { completeSystemTasks } from './timeline';

export const DEPOSIT_METHOD_LABEL: Record<DepositMethod, string> = {
  BANK_TRANSFER: 'Bank transfer',
  GATEWAY: 'Pylon payment gateway',
  FINANCE: 'Finance / loan approval',
};

export interface SubmitDepositInput {
  orderId: string;
  amountCents: number | null;
  /** BANK_TRANSFER or FINANCE. Gateway deposits are created by the Pylon integration. */
  method: string;
  note?: string;
  /** Transfer screenshot(s) or the loan approval. */
  files: StagedFile[];
  /** The quote version the customer is paying the deposit for. Needed when the order has more than one. */
  quoteId?: string | null;
}

/**
 * Sales files the proof that the deposit was paid, and with it which proposal the customer
 * went ahead with. From here the order can be pushed to operations once its folder is complete.
 */
export async function submitDeposit(ctx: Ctx, input: SubmitDepositInput): Promise<{ id: string }> {
  try {
    const errors = new FieldErrors();
    if (input.amountCents === null || input.amountCents <= 0) errors.add('amount', 'Enter the deposit amount.');
    const method = input.method === 'BANK_TRANSFER' || input.method === 'FINANCE' ? input.method : null;
    if (!method) errors.add('method', 'Choose how the deposit was paid.');
    if (input.files.length === 0) errors.add('files', method === 'FINANCE' ? 'Attach the finance approval.' : 'Attach the payment screenshot or receipt.');
    errors.throwIfAny();
    const note = (input.note ?? '').trim().slice(0, 1000);

    const result = await inTx(ctx.db, async (tx) => {
      const order = await lockOrderForWork(tx, ctx, input.orderId);
      if (order.deposit !== 'NONE') {
        throw new ConflictError(order.deposit === 'PENDING' ? 'A deposit is already on record. Withdraw it first if it is wrong.' : 'The deposit for this order has already been confirmed.');
      }
      // Which proposal the money is for. One version needs no asking; several do.
      const quotes = await tx.quote.findMany({ where: { orderId: order.id }, select: { id: true, isAccepted: true } });
      const chosen = input.quoteId ? quotes.find((q) => q.id === input.quoteId) : quotes.length === 1 ? quotes[0] : quotes.find((q) => q.isAccepted);
      if (input.quoteId && !chosen) throw new ValidationError('Choose one of this order’s quote versions.', { quoteId: 'Choose a version.' });
      if (!chosen && quotes.length > 1) throw new ValidationError('Say which proposal the customer accepted.', { quoteId: 'Choose the version the customer accepted.' });
      if (chosen) await acceptQuoteInTx(tx, ctx, order, chosen.id);
      const type = await tx.documentType.findUniqueOrThrow({ where: { key: DOC_TYPE.depositProof } });
      const documents: Document[] = [];
      for (const file of input.files) documents.push(await attachStaged(tx, ctx, order, file, { type }));
      const id = newId('dep');
      const now = nowOf(ctx);
      await tx.deposit.create({
        data: {
          id,
          orderId: order.id,
          amountCents: input.amountCents!,
          method: method!,
          proofDocumentId: documents[0]!.id,
          note,
          submittedById: ctx.actor.kind === 'user' ? ctx.actor.id : null,
          submittedAt: now,
        },
      });
      const summary = `Deposit of ${formatCents(input.amountCents)} recorded (${DEPOSIT_METHOD_LABEL[method!].toLowerCase()})`;
      await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary, body: note, payload: { depositId: id } });
      // What the system had asked for is done: a new record after a rejected one, the deposit after Pylon showed the sale.
      await completeSystemTasks(tx, ctx, order.id, ['DEPOSIT_REJECTED', 'PYLON_ACCEPTED']);
      await touchStaffActivity(tx, ctx, order);
      await syncOrderStage(tx, ctx, order.id);
      await audit(tx, ctx, {
        action: 'deposit.submit',
        entityType: 'Deposit',
        entityId: id,
        orderId: order.id,
        customerId: order.customerId,
        summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
        after: { amountCents: input.amountCents, method, note, quoteId: chosen?.id ?? null, documentIds: documents.map((d) => d.id) },
      });
      return { id, documents };
    });
    for (const doc of result.documents) await finishImage(ctx, doc);
    return { id: result.id };
  } catch (e) {
    await cleanupStaged(input.files);
    throw e;
  }
}

export interface GatewayDepositInput {
  amountCents: number;
  currency: string;
  receiptUrl: string | null;
  pylonEventId: string;
}

/**
 * Records a deposit paid through the Pylon payment gateway. The gateway's receipt stands in for
 * the payment screenshot. Must run inside a transaction holding the order lock.
 */
export async function createGatewayDeposit(tx: Tx, ctx: Ctx, order: OrderState, input: GatewayDepositInput): Promise<'created' | 'already_recorded' | 'deposit_exists'> {
  if (await tx.deposit.findUnique({ where: { pylonEventId: input.pylonEventId }, select: { id: true } })) return 'already_recorded';
  if (order.deposit !== 'NONE') {
    await addActivity(tx, ctx, {
      customerId: order.customerId,
      orderId: order.id,
      type: 'DEPOSIT',
      summary: `Pylon reported a gateway payment of ${formatCents(input.amountCents, input.currency)}, but a deposit is already on record`,
      payload: { receiptUrl: input.receiptUrl, pylonEventId: input.pylonEventId },
    });
    return 'deposit_exists';
  }
  const id = newId('dep');
  await tx.deposit.create({
    data: {
      id,
      orderId: order.id,
      amountCents: input.amountCents,
      currency: input.currency,
      method: 'GATEWAY',
      receiptUrl: input.receiptUrl,
      pylonEventId: input.pylonEventId,
      submittedAt: nowOf(ctx),
    },
  });
  const summary = `Deposit of ${formatCents(input.amountCents, input.currency)} paid through the Pylon payment gateway`;
  await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary, payload: { depositId: id, receiptUrl: input.receiptUrl } });
  await completeSystemTasks(tx, ctx, order.id, ['PYLON_ACCEPTED']);
  await syncOrderStage(tx, ctx, order.id);
  await audit(tx, ctx, {
    action: 'deposit.submit',
    entityType: 'Deposit',
    entityId: id,
    orderId: order.id,
    customerId: order.customerId,
    summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
    after: { amountCents: input.amountCents, currency: input.currency, method: 'GATEWAY', receiptUrl: input.receiptUrl },
  });
  await notifyUsers(tx, ctx, [order.ownerId], {
    type: 'deposit.gateway',
    title: `${order.orderNo}: the customer paid the deposit through Pylon`,
    href: orderHref(order.id),
    orderId: order.id,
  });
  return 'created';
}

async function findDeposit(ctx: Ctx, depositId: string): Promise<Deposit> {
  const deposit = await ctx.db.deposit.findUnique({ where: { id: depositId } });
  if (!deposit) throw new NotFoundError('Deposit not found.');
  return deposit;
}

/** Sales takes back a deposit record that was wrong. Possible until operations has confirmed the money. */
export async function withdrawDeposit(ctx: Ctx, input: { depositId: string }): Promise<void> {
  const found = await findDeposit(ctx, input.depositId);
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForWork(tx, ctx, found.orderId, 'Deposit');
    const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: found.id } });
    if (deposit.status !== 'PENDING') throw new ConflictError('Operations has confirmed this deposit. It can no longer be withdrawn.');
    await tx.deposit.update({ where: { id: deposit.id }, data: { status: 'WITHDRAWN', decidedAt: nowOf(ctx), decisionNote: 'Withdrawn by sales' } });
    await supersedeDocuments(tx, ctx, order.id, DOC_TYPE.depositProof);
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary: `Deposit record of ${formatCents(deposit.amountCents, deposit.currency)} withdrawn` });
    await touchStaffActivity(tx, ctx, order);
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'deposit.withdraw',
      entityType: 'Deposit',
      entityId: deposit.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: deposit record withdrawn`,
      before: { status: 'PENDING' },
      after: { status: 'WITHDRAWN' },
    });
  });
}

/**
 * Operations confirms that the deposit has arrived. It happens as part of accepting the order,
 * inside that transaction, and finance is told. Returns the confirmed deposit, or null when the
 * order has none on record.
 */
export async function confirmDepositReceived(tx: Tx, ctx: Ctx, order: OrderState): Promise<Deposit | null> {
  const deposit = await tx.deposit.findFirst({ where: { orderId: order.id, status: { in: ['PENDING', 'CONFIRMED'] } }, orderBy: { submittedAt: 'desc' } });
  if (!deposit) return null;
  if (deposit.status === 'CONFIRMED') return deposit;
  const now = nowOf(ctx);
  const receivedOn = todayDateOnly(now, getConfig().timeZone);
  const confirmed = await tx.deposit.update({
    where: { id: deposit.id },
    data: { status: 'CONFIRMED', receivedAmountCents: deposit.amountCents, receivedOn, decidedById: ctx.actor.kind === 'user' ? ctx.actor.id : null, decidedAt: now },
  });
  const summary = `Deposit of ${formatCents(deposit.amountCents, deposit.currency)} confirmed as received`;
  await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary, payload: { depositId: deposit.id } });
  await audit(tx, ctx, {
    action: 'deposit.confirm',
    entityType: 'Deposit',
    entityId: deposit.id,
    orderId: order.id,
    customerId: order.customerId,
    summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
    before: { status: 'PENDING' },
    after: { status: 'CONFIRMED', receivedAmountCents: deposit.amountCents, receivedOn },
  });
  await notifyRoles(tx, ctx, ['FINANCE'], {
    type: 'deposit.received',
    title: `Deposit received: ${order.orderNo}, ${formatCents(deposit.amountCents, deposit.currency)}`,
    body: 'Operations has accepted the order and confirmed that the deposit arrived.',
    href: `/finance/deposits/${deposit.id}`,
    orderId: order.id,
  });
  return confirmed;
}
