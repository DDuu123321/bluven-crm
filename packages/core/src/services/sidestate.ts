// Lost, on hold and cancelled: the side states that run alongside the main stages.
import type { RefundStatus, Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { getConfig } from '../config';
import { can, canCancel, canHold, canMarkLost, canRestore, canResume, formatDateOnly, hasRole, isManager, isOrderStaff, isWithOperations, orderViewFor, todayDateOnly } from '../domain';
import { ConflictError, FieldErrors, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit } from './audit';
import { managerIds, notifyRoles, notifyUsers } from './notify';
import { accessFacts, lockOrder, lockOrderForStaff, loadOrderState, orderHref, syncOrderStage, touchStaffActivity, type OrderState } from './orders';

function ensure(check: { ok: true } | { ok: false; reason: string }): void {
  if (!check.ok) throw new ConflictError(check.reason);
}

async function cancelOpenTasks(tx: Tx, orderId: string): Promise<void> {
  await tx.task.updateMany({ where: { orderId, status: 'OPEN' }, data: { status: 'CANCELLED' } });
}

export async function markLost(ctx: Ctx, input: { orderId: string; reasonId: string; note?: string }): Promise<void> {
  const note = (input.note ?? '').trim().slice(0, 2000);
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    ensure(canMarkLost(order));
    const reason = await tx.lostReason.findUnique({ where: { id: input.reasonId } });
    if (!reason || !reason.isActive) throw new ValidationError('Choose why the order was lost.', { reasonId: 'Choose a reason.' });
    const now = nowOf(ctx);
    await tx.order.update({
      where: { id: order.id },
      data: { sideState: 'LOST', lostReasonId: reason.id, lostNote: note, lostAt: now, onHoldUntil: null },
    });
    await cancelOpenTasks(tx, order.id);
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'SYSTEM', summary: `Marked as lost: ${reason.label}`, body: note });
    await touchStaffActivity(tx, ctx, order);
    await audit(tx, ctx, {
      action: 'order.lost',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo} marked as lost: ${reason.label}`,
      before: { sideState: order.sideState },
      after: { sideState: 'LOST', lostReason: reason.key, lostNote: note },
    });
  });
}

/** Managers only: brings a lost order back to life in the stage it was in. */
export async function restoreLost(ctx: Ctx, input: { orderId: string }): Promise<void> {
  if (ctx.actor.kind === 'user' && !can(ctx.actor, 'orders.restoreLost')) throw new ForbiddenError('Only a manager can restore a lost order.');
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    ensure(canRestore(order));
    const now = nowOf(ctx);
    await tx.order.update({
      where: { id: order.id },
      data: { sideState: 'NONE', lostReasonId: null, lostNote: '', lostAt: null, lastStaffActivityAt: now, idleLevel: 0 },
    });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'SYSTEM', summary: 'Restored from lost' });
    await audit(tx, ctx, {
      action: 'order.restore',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo} restored from lost`,
      before: { sideState: 'LOST' },
      after: { sideState: 'NONE' },
    });
    await notifyUsers(tx, ctx, [order.ownerId], {
      type: 'order.restored',
      title: `${order.orderNo} has been restored`,
      href: orderHref(order.id),
      orderId: order.id,
    });
  });
}

export async function holdOrder(ctx: Ctx, input: { orderId: string; until: Date | null; note?: string }): Promise<void> {
  const errors = new FieldErrors();
  const today = todayDateOnly(nowOf(ctx), getConfig().timeZone);
  if (!input.until) errors.add('until', 'Choose the date to follow up.');
  else if (input.until.getTime() <= today.getTime()) errors.add('until', 'Choose a date after today.');
  else if (input.until.getTime() > today.getTime() + 730 * 86_400_000) errors.add('until', 'Choose a date within the next two years.');
  errors.throwIfAny();
  const note = (input.note ?? '').trim().slice(0, 2000);

  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    ensure(canHold(order));
    await tx.order.update({ where: { id: order.id }, data: { sideState: 'ON_HOLD', onHoldUntil: input.until, onHoldNote: note } });
    await addActivity(tx, ctx, {
      customerId: order.customerId,
      orderId: order.id,
      type: 'SYSTEM',
      summary: `Put on hold until ${formatDateOnly(input.until)}`,
      body: note,
    });
    await touchStaffActivity(tx, ctx, order);
    await audit(tx, ctx, {
      action: 'order.hold',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo} put on hold until ${formatDateOnly(input.until)}`,
      before: { sideState: order.sideState },
      after: { sideState: 'ON_HOLD', onHoldUntil: input.until, onHoldNote: note },
    });
  });
}

/**
 * Takes an order off hold inside the caller's transaction. Used by the manual "Resume" action
 * and by the worker when the follow-up date arrives.
 */
export async function resumeOrderInTx(tx: Tx, ctx: Ctx, order: OrderState, automatic: boolean): Promise<void> {
  ensure(canResume(order));
  const now = nowOf(ctx);
  // The idle clock restarts from here.
  await tx.order.update({
    where: { id: order.id },
    data: { sideState: 'NONE', onHoldUntil: null, lastStaffActivityAt: now, idleLevel: 0 },
  });
  await addActivity(tx, ctx, {
    customerId: order.customerId,
    orderId: order.id,
    type: 'SYSTEM',
    summary: automatic ? 'Hold ended: the follow-up date has arrived' : 'Taken off hold',
  });
  await audit(tx, ctx, {
    action: 'order.resume',
    entityType: 'Order',
    entityId: order.id,
    orderId: order.id,
    customerId: order.customerId,
    summary: `${order.orderNo} taken off hold${automatic ? ' automatically' : ''}`,
    before: { sideState: 'ON_HOLD' },
    after: { sideState: 'NONE' },
  });
  if (automatic) {
    await tx.task.create({
      data: {
        id: newId('tsk'),
        orderId: order.id,
        assigneeId: order.ownerId,
        title: 'Follow up: the hold period has ended',
        dueAt: now,
        kind: 'HOLD_ENDED',
        remindedAt: now, // the notification below is the reminder
        createdAt: now,
      },
    });
    const recipients = order.ownerId ? [order.ownerId] : await managerIds(tx);
    await notifyUsers(tx, ctx, recipients, {
      type: 'order.hold_ended',
      title: `${order.orderNo} is off hold: time to follow up`,
      href: orderHref(order.id),
      orderId: order.id,
    });
  }
}

export async function resumeOrder(ctx: Ctx, input: { orderId: string }): Promise<void> {
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    await resumeOrderInTx(tx, ctx, order, false);
  });
}

const REFUND_STATUSES: RefundStatus[] = ['NOT_REQUIRED', 'PENDING', 'REFUNDED'];
export const REFUND_LABEL: Record<RefundStatus, string> = {
  NOT_REQUIRED: 'No refund needed',
  PENDING: 'Refund to be paid',
  REFUNDED: 'Refunded',
};

/**
 * Who may cancel: the salesperson or a manager while the order is still theirs; once operations
 * has accepted it, operations or a manager.
 */
async function lockOrderForCancel(tx: Tx, ctx: Ctx, orderId: string): Promise<OrderState> {
  await lockOrder(tx, orderId);
  const order = await loadOrderState(tx, orderId);
  if (!order) throw new NotFoundError('Order not found.');
  if (ctx.actor.kind !== 'user') return order;
  if (!orderViewFor(ctx.actor, accessFacts(order))) throw new NotFoundError('Order not found.');
  if (isWithOperations(order.stage)) {
    if (!isManager(ctx.actor) && !can(ctx.actor, 'ops.handoffs')) throw new ForbiddenError('Operations has accepted this order. Only operations or a manager can cancel it now.');
  } else if (!isOrderStaff(ctx.actor, order)) {
    throw new ForbiddenError('Only the salesperson for this order or a manager can do this.');
  }
  return order;
}

export async function cancelOrder(ctx: Ctx, input: { orderId: string; note: string; refundStatus: string }): Promise<void> {
  const errors = new FieldErrors();
  const note = input.note.trim().slice(0, 2000);
  if (!note) errors.add('note', 'Say why the order is being cancelled.');
  const refundStatus = REFUND_STATUSES.find((s) => s === input.refundStatus);
  if (!refundStatus) errors.add('refundStatus', 'Choose the refund status.');
  errors.throwIfAny();

  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForCancel(tx, ctx, input.orderId);
    ensure(canCancel(order));
    const now = nowOf(ctx);
    // If operations has it in their inbox, take it out.
    const pending = await tx.handoffPackage.findFirst({ where: { orderId: order.id, decision: 'PENDING' } });
    if (pending) {
      await tx.handoffPackage.update({ where: { id: pending.id }, data: { decision: 'WITHDRAWN', decidedAt: now, returnReason: 'Order cancelled by sales' } });
      await notifyRoles(tx, ctx, ['OPS'], {
        type: 'handoff.withdrawn',
        title: `${order.orderNo} was cancelled and withdrawn from your inbox`,
        body: note,
      });
    }
    // Nothing more goes to the customer by itself.
    await tx.customerNotice.updateMany({ where: { orderId: order.id, status: 'PENDING' }, data: { status: 'SKIPPED', nextAttemptAt: null, note: 'The order was cancelled before this went out.' } });
    await tx.order.update({
      where: { id: order.id },
      data: { sideState: 'CANCELLED', cancelledAt: now, cancelNote: note, refundStatus: refundStatus!, onHoldUntil: null },
    });
    await cancelOpenTasks(tx, order.id);
    await addActivity(tx, ctx, {
      customerId: order.customerId,
      orderId: order.id,
      type: 'SYSTEM',
      summary: `Order cancelled (${REFUND_LABEL[refundStatus!].toLowerCase()})`,
      body: note,
    });
    await touchStaffActivity(tx, ctx, order);
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'order.cancel',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo} cancelled`,
      before: { sideState: order.sideState },
      after: { sideState: 'CANCELLED', cancelNote: note, refundStatus },
    });
    // Once operations has the order, its salesperson hears about the cancellation too, and so does operations.
    const afterAcceptance = isWithOperations(order.stage);
    await notifyUsers(tx, ctx, [...(await managerIds(tx)), ...(afterAcceptance ? [order.ownerId] : [])], {
      type: 'order.cancelled',
      title: `${order.orderNo} was cancelled after a deposit`,
      body: note,
      href: orderHref(order.id),
      orderId: order.id,
    });
    if (afterAcceptance) {
      await notifyRoles(tx, ctx, ['OPS'], { type: 'handoff.withdrawn', title: `${order.orderNo} was cancelled`, body: note, href: `/ops/orders/${order.id}`, orderId: order.id });
    }
    if (refundStatus === 'PENDING') {
      await notifyRoles(tx, ctx, ['FINANCE'], {
        type: 'refund.pending',
        title: `Refund needed for ${order.orderNo}`,
        body: note,
        href: '/finance?tab=refunds',
        orderId: order.id,
      });
    }
  });
}

/** Finance or a manager records how the refund of a cancelled order stands. */
export async function setRefundStatus(ctx: Ctx, input: { orderId: string; refundStatus: string }): Promise<void> {
  if (ctx.actor.kind === 'user' && !(hasRole(ctx.actor, 'FINANCE') || isManager(ctx.actor))) throw new ForbiddenError();
  const refundStatus = REFUND_STATUSES.find((s) => s === input.refundStatus);
  if (!refundStatus) throw new ValidationError('Choose the refund status.');
  await inTx(ctx.db, async (tx) => {
    await lockOrder(tx, input.orderId);
    const order = await loadOrderState(tx, input.orderId);
    if (!order) throw new NotFoundError('Order not found.');
    if (order.sideState !== 'CANCELLED') throw new ConflictError('Only a cancelled order has a refund status.');
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { refundStatus: true } });
    if (current.refundStatus === refundStatus) return;
    await tx.order.update({ where: { id: order.id }, data: { refundStatus } });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary: `Refund status: ${REFUND_LABEL[refundStatus]}` });
    await audit(tx, ctx, {
      action: 'order.refund_status',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo} refund status set to ${REFUND_LABEL[refundStatus]}`,
      before: { refundStatus: current.refundStatus },
      after: { refundStatus },
    });
    await notifyUsers(tx, ctx, [order.ownerId], {
      type: 'refund.updated',
      title: `${order.orderNo}: ${REFUND_LABEL[refundStatus]}`,
      href: orderHref(order.id),
      orderId: order.id,
    });
  });
}

/** Managers clear the "possible duplicate" flag once they have looked at it. */
export async function dismissDuplicateFlag(ctx: Ctx, input: { orderId: string }): Promise<void> {
  if (ctx.actor.kind === 'user' && !isManager(ctx.actor)) throw new ForbiddenError();
  await inTx(ctx.db, async (tx) => {
    await lockOrder(tx, input.orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { id: true, orderNo: true, customerId: true, possibleDuplicateOfId: true } });
    if (!order.possibleDuplicateOfId) return;
    await tx.order.update({ where: { id: order.id }, data: { duplicateDismissedAt: nowOf(ctx) } });
    await audit(tx, ctx, {
      action: 'order.duplicate_dismissed',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: possible-duplicate flag dismissed`,
      meta: { possibleDuplicateOfId: order.possibleDuplicateOfId },
    });
  });
}
