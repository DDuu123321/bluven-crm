// Deposits. Sales submits proof of payment, finance confirms that the money has arrived.
import type { Deposit, DepositMethod, Document, Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { getConfig } from '../config';
import { can, formatCents, formatDateOnly, todayDateOnly } from '../domain';
import { ConflictError, FieldErrors, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit } from './audit';
import { attachStaged, cleanupStaged, finishImage, supersedeDocuments, type StagedFile } from './documents';
import { managerIds, notifyRoles, notifyUsers } from './notify';
import { lockOrder, lockOrderForEdit, loadOrderState, orderHref, syncOrderStage, touchStaffActivity, type OrderState } from './orders';
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
}

/** Sales submits proof that the deposit was paid. The order waits for finance from here. */
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
      const order = await lockOrderForEdit(tx, ctx, input.orderId);
      const contract = await tx.contract.findFirst({ where: { orderId: order.id, voidedAt: null }, select: { id: true } });
      if (!contract) throw new ConflictError('Archive the signed contract before recording the deposit.');
      if (order.deposit !== 'NONE') {
        throw new ConflictError(order.deposit === 'PENDING' ? 'A deposit is already waiting for finance. Withdraw it first if it is wrong.' : 'The deposit for this order has already been confirmed.');
      }
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
      const summary = `Deposit of ${formatCents(input.amountCents)} submitted for confirmation (${DEPOSIT_METHOD_LABEL[method!].toLowerCase()})`;
      await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary, body: note, payload: { depositId: id } });
      await completeSystemTasks(tx, ctx, order.id, ['DEPOSIT_REJECTED']);
      await touchStaffActivity(tx, ctx, order);
      await syncOrderStage(tx, ctx, order.id);
      await audit(tx, ctx, {
        action: 'deposit.submit',
        entityType: 'Deposit',
        entityId: id,
        orderId: order.id,
        customerId: order.customerId,
        summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
        after: { amountCents: input.amountCents, method, note, documentIds: documents.map((d) => d.id) },
      });
      await notifyRoles(tx, ctx, ['FINANCE'], {
        type: 'deposit.submitted',
        title: `Deposit to confirm: ${order.orderNo}, ${formatCents(input.amountCents)}`,
        href: `/finance/deposits/${id}`,
        orderId: order.id,
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
 * Records a deposit paid through the Pylon payment gateway. It still waits for finance. The
 * payment may arrive before the contract does: the record is created regardless and the stage
 * follows once the contract is archived. Must run inside a transaction holding the order lock.
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
  await notifyRoles(tx, ctx, ['FINANCE'], {
    type: 'deposit.submitted',
    title: `Deposit to confirm: ${order.orderNo}, ${formatCents(input.amountCents, input.currency)} (gateway)`,
    href: `/finance/deposits/${id}`,
    orderId: order.id,
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

/** Sales takes back a submission that finance has not decided on yet. */
export async function withdrawDeposit(ctx: Ctx, input: { depositId: string }): Promise<void> {
  const found = await findDeposit(ctx, input.depositId);
  await inTx(ctx.db, async (tx) => {
    // On a cancelled order the submission is finance's to close out, so that whether money
    // arrived is on record before anyone talks about a refund.
    const order = await lockOrderForEdit(tx, ctx, found.orderId, 'Deposit');
    const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: found.id } });
    if (deposit.status !== 'PENDING') throw new ConflictError('Only a deposit that is still waiting for finance can be withdrawn.');
    await tx.deposit.update({ where: { id: deposit.id }, data: { status: 'WITHDRAWN', decidedAt: nowOf(ctx), decisionNote: 'Withdrawn by sales' } });
    await supersedeDocuments(tx, ctx, order.id, DOC_TYPE.depositProof);
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary: `Deposit submission of ${formatCents(deposit.amountCents, deposit.currency)} withdrawn` });
    await touchStaffActivity(tx, ctx, order);
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'deposit.withdraw',
      entityType: 'Deposit',
      entityId: deposit.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: deposit submission withdrawn`,
      before: { status: 'PENDING' },
      after: { status: 'WITHDRAWN' },
    });
  });
}

export interface DecideDepositInput {
  depositId: string;
  decision: 'CONFIRM' | 'REJECT';
  /** CONFIRM: what actually arrived. */
  receivedAmountCents?: number | null;
  receivedOn?: Date | null;
  bankReference?: string;
  /** REJECT: required reason. CONFIRM: optional remark. */
  note?: string;
}

/** Finance confirms that the money has arrived, or rejects the submission with a reason. */
export async function decideDeposit(ctx: Ctx, input: DecideDepositInput): Promise<void> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'finance.deposits')) throw new ForbiddenError('Only finance can confirm or reject a deposit.');
  const actor = ctx.actor;
  const errors = new FieldErrors();
  const note = (input.note ?? '').trim().slice(0, 1000);
  const bankReference = (input.bankReference ?? '').trim().slice(0, 100);
  if (input.decision === 'CONFIRM') {
    if (!input.receivedAmountCents || input.receivedAmountCents <= 0) errors.add('receivedAmount', 'Enter the amount received.');
    if (!input.receivedOn) errors.add('receivedOn', 'Enter the date the money arrived.');
    else if (input.receivedOn > todayDateOnly(nowOf(ctx), getConfig().timeZone)) errors.add('receivedOn', 'This date cannot be in the future.');
  } else if (!note) {
    errors.add('note', 'Say why the deposit is rejected, so sales can fix it.');
  }
  errors.throwIfAny();
  const found = await findDeposit(ctx, input.depositId);

  await inTx(ctx.db, async (tx) => {
    await lockOrder(tx, found.orderId);
    const order = (await loadOrderState(tx, found.orderId))!;
    const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: found.id } });
    if (deposit.status !== 'PENDING') throw new ConflictError('This deposit has already been decided or withdrawn.');
    // A cancelled order can still have a submission waiting. Finance decides it all the same:
    // whether the money arrived is exactly what a refund depends on.
    const cancelled = order.sideState === 'CANCELLED';
    const now = nowOf(ctx);

    if (input.decision === 'CONFIRM') {
      await tx.deposit.update({
        where: { id: deposit.id },
        data: {
          status: 'CONFIRMED',
          receivedAmountCents: input.receivedAmountCents!,
          receivedOn: input.receivedOn!,
          bankReference,
          decisionNote: note,
          decidedById: actor.id,
          decidedAt: now,
        },
      });
      const differs = input.receivedAmountCents !== deposit.amountCents;
      const summary = `Deposit confirmed by finance: ${formatCents(input.receivedAmountCents, deposit.currency)} received on ${formatDateOnly(input.receivedOn)}${
        differs ? ` (submitted as ${formatCents(deposit.amountCents, deposit.currency)})` : ''
      }`;
      await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary, body: note, payload: { depositId: deposit.id, bankReference } });
      // The wait for finance is over and the ball is back with sales: the idle clock starts now.
      if (!cancelled) await tx.order.update({ where: { id: order.id }, data: { lastStaffActivityAt: now, idleLevel: 0 } });
      await syncOrderStage(tx, ctx, order.id);
      await audit(tx, ctx, {
        action: 'deposit.confirm',
        entityType: 'Deposit',
        entityId: deposit.id,
        orderId: order.id,
        customerId: order.customerId,
        summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
        before: { status: 'PENDING', amountCents: deposit.amountCents },
        after: { status: 'CONFIRMED', receivedAmountCents: input.receivedAmountCents, receivedOn: input.receivedOn, bankReference, note },
      });
      if (cancelled) {
        await notifyUsers(tx, ctx, [order.ownerId, ...(await managerIds(tx))], {
          type: 'deposit.confirmed',
          title: `${order.orderNo}: deposit confirmed on a cancelled order`,
          body: 'The money did arrive. Check that the refund status of the order is right.',
          href: orderHref(order.id),
          orderId: order.id,
        });
      } else {
        const recipients = order.ownerId ? [order.ownerId] : await managerIds(tx);
        await notifyUsers(tx, ctx, recipients, {
          type: 'deposit.confirmed',
          title: `${order.orderNo}: deposit confirmed`,
          body: 'You can push the order to operations once the checklist is complete.',
          href: orderHref(order.id),
          orderId: order.id,
        });
      }
    } else {
      await tx.deposit.update({
        where: { id: deposit.id },
        data: { status: 'REJECTED', decisionNote: note, decidedById: actor.id, decidedAt: now },
      });
      await supersedeDocuments(tx, ctx, order.id, DOC_TYPE.depositProof);
      await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary: 'Deposit rejected by finance', body: note, payload: { depositId: deposit.id } });
      if (!cancelled) {
        await tx.task.create({
          data: {
            id: newId('tsk'),
            orderId: order.id,
            assigneeId: order.ownerId,
            title: 'Deposit rejected by finance: check with the customer and resubmit',
            notes: note,
            dueAt: now,
            kind: 'DEPOSIT_REJECTED',
            remindedAt: now,
            createdAt: now,
          },
        });
        // The ball is back with sales: the idle clock starts now.
        await tx.order.update({ where: { id: order.id }, data: { lastStaffActivityAt: now, idleLevel: 0 } });
      }
      await syncOrderStage(tx, ctx, order.id);
      await audit(tx, ctx, {
        action: 'deposit.reject',
        entityType: 'Deposit',
        entityId: deposit.id,
        orderId: order.id,
        customerId: order.customerId,
        summary: `${order.orderNo}: deposit rejected by finance`,
        before: { status: 'PENDING' },
        after: { status: 'REJECTED', reason: note },
      });
      await notifyUsers(tx, ctx, [order.ownerId, ...(await managerIds(tx))], {
        type: 'deposit.rejected',
        title: `${order.orderNo}: deposit rejected by finance`,
        body: note,
        href: orderHref(order.id),
        orderId: order.id,
      });
    }
  });
}

/** Finance undoes a confirmation made by mistake. Only possible before the order goes to operations. */
export async function reopenDeposit(ctx: Ctx, input: { depositId: string; reason: string }): Promise<void> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'finance.deposits')) throw new ForbiddenError('Only finance can reopen a deposit.');
  const reason = input.reason.trim().slice(0, 1000);
  if (!reason) throw new ValidationError('Say why the confirmation is being undone.', { reason: 'Give a reason.' });
  const found = await findDeposit(ctx, input.depositId);
  await inTx(ctx.db, async (tx) => {
    await lockOrder(tx, found.orderId);
    const order = (await loadOrderState(tx, found.orderId))!;
    const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: found.id } });
    if (deposit.status !== 'CONFIRMED') throw new ConflictError('Only a confirmed deposit can be reopened.');
    if (order.sideState === 'CANCELLED') throw new ConflictError('This order has been cancelled. Record what happens to the money under its refund status.');
    if (order.stage === 'PUSHED' || order.stage === 'RETURNED' || order.stage === 'HANDED_OVER') {
      throw new ConflictError('This order has already gone to operations, so the confirmation can no longer be undone here.');
    }
    await tx.deposit.update({
      where: { id: deposit.id },
      data: { status: 'PENDING', receivedAmountCents: null, receivedOn: null, bankReference: '', decisionNote: '', decidedById: null, decidedAt: null },
    });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary: 'Deposit confirmation undone by finance', body: reason });
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'deposit.reopen',
      entityType: 'Deposit',
      entityId: deposit.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: deposit confirmation undone`,
      before: { status: 'CONFIRMED', receivedAmountCents: deposit.receivedAmountCents, receivedOn: deposit.receivedOn, bankReference: deposit.bankReference },
      after: { status: 'PENDING', reason },
    });
    await notifyUsers(tx, ctx, [order.ownerId, ...(await managerIds(tx))], {
      type: 'deposit.reopened',
      title: `${order.orderNo}: finance undid the deposit confirmation`,
      body: reason,
      href: orderHref(order.id),
      orderId: order.id,
    });
  });
}
