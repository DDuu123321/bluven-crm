// Order ownership: assign, reassign, return to the pool, bulk transfer.
import type { Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { OPERATIONS_STAGES, can } from '../domain';
import { ForbiddenError, ValidationError } from '../errors';
import { addActivity } from './activity';
import { audit } from './audit';
import { requireAssignableUser } from './intake';
import { managerIds, notifyUsers } from './notify';
import { lockOrder, orderHref } from './orders';

function requireAssigner(ctx: Ctx): void {
  if (ctx.actor.kind === 'user' && !can(ctx.actor, 'orders.assign')) throw new ForbiddenError('Only a manager can assign orders.');
}

export type OwnerChangeReason =
  | { kind: 'assign' }
  | { kind: 'pool'; note?: string }
  | { kind: 'idle'; days: number };

/**
 * Changes the owner of one order inside the caller's transaction. Open tasks follow the order,
 * the idle clock restarts, and both the old and the new owner are told. Returns false when the
 * order already has that owner.
 */
export async function setOrderOwner(tx: Tx, ctx: Ctx, orderId: string, newOwnerId: string | null, reason: OwnerChangeReason): Promise<boolean> {
  await lockOrder(tx, orderId);
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, orderNo: true, customerId: true, ownerId: true, owner: { select: { name: true } } },
  });
  if (order.ownerId === newOwnerId) return false;
  const now = nowOf(ctx);
  const newOwner = newOwnerId ? await tx.user.findUniqueOrThrow({ where: { id: newOwnerId }, select: { name: true } }) : null;

  await tx.order.update({
    where: { id: orderId },
    // Once somebody has been given an order it is a live lead: if it ever comes back unassigned
    // it belongs in the pool, not under "imported history".
    data: { ownerId: newOwnerId, assignedAt: newOwnerId ? now : undefined, lastStaffActivityAt: now, idleLevel: 0, ...(newOwnerId ? { isBackfill: false } : {}) },
  });
  // The idle clock starts again with the new owner, so a "no activity" task of the old one is void.
  await tx.task.updateMany({ where: { orderId, kind: 'IDLE', status: 'OPEN' }, data: { status: 'CANCELLED' } });
  // Open tasks travel with the order. In the pool they belong to nobody.
  await tx.task.updateMany({
    where: { orderId, status: 'OPEN', OR: [{ assigneeId: order.ownerId }, { assigneeId: null }] },
    data: { assigneeId: newOwnerId },
  });

  let summary: string;
  if (newOwner) {
    summary = order.owner ? `Reassigned from ${order.owner.name} to ${newOwner.name}` : `Assigned to ${newOwner.name}`;
  } else if (reason.kind === 'idle') {
    summary = `Returned to the unassigned pool automatically after ${reason.days} days without activity (was with ${order.owner?.name ?? 'nobody'})`;
  } else {
    summary = `Returned to the unassigned pool (was with ${order.owner?.name ?? 'nobody'})`;
  }
  await addActivity(tx, ctx, {
    customerId: order.customerId,
    orderId,
    type: 'ASSIGNMENT',
    summary,
    body: reason.kind === 'pool' ? (reason.note ?? '') : '',
    payload: { from: order.ownerId, to: newOwnerId, reason: reason.kind },
  });
  await audit(tx, ctx, {
    action: newOwnerId ? 'order.assign' : 'order.unassign',
    entityType: 'Order',
    entityId: orderId,
    orderId,
    customerId: order.customerId,
    summary: `${order.orderNo}: ${summary}`,
    before: { ownerId: order.ownerId },
    after: { ownerId: newOwnerId },
    meta: { reason },
  });

  if (newOwnerId) {
    await notifyUsers(tx, ctx, [newOwnerId], {
      type: 'order.assigned',
      title: `${order.orderNo} has been assigned to you`,
      href: orderHref(orderId),
      orderId,
    });
  }
  if (order.ownerId) {
    await notifyUsers(tx, ctx, [order.ownerId], {
      type: 'order.unassigned',
      title: newOwner ? `${order.orderNo} was reassigned to ${newOwner.name}` : `${order.orderNo} was returned to the unassigned pool`,
      body: reason.kind === 'idle' ? `No activity was recorded for ${reason.days} days.` : '',
      orderId: null, // the former owner can no longer open it
    });
  }
  if (!newOwnerId && reason.kind === 'idle') {
    await notifyUsers(tx, ctx, await managerIds(tx), {
      type: 'order.idle_returned',
      title: `${order.orderNo} returned to the pool after ${reason.days} idle days`,
      body: `It was with ${order.owner?.name ?? 'nobody'}.`,
      href: orderHref(orderId),
      orderId,
    });
  }
  return true;
}

/** Assigns (or reassigns) the given orders to one salesperson. */
export async function assignOrders(ctx: Ctx, input: { orderIds: string[]; ownerId: string }): Promise<{ changed: number }> {
  requireAssigner(ctx);
  if (input.orderIds.length === 0) throw new ValidationError('Select at least one order.');
  await requireAssignableUser(ctx.db, input.ownerId);
  let changed = 0;
  for (const orderId of [...new Set(input.orderIds)]) {
    if (await inTx(ctx.db, (tx) => setOrderOwner(tx, ctx, orderId, input.ownerId, { kind: 'assign' }))) changed++;
  }
  return { changed };
}

/** Puts the given orders back into the unassigned pool. */
export async function returnOrdersToPool(ctx: Ctx, input: { orderIds: string[]; note?: string }): Promise<{ changed: number }> {
  requireAssigner(ctx);
  if (input.orderIds.length === 0) throw new ValidationError('Select at least one order.');
  let changed = 0;
  for (const orderId of [...new Set(input.orderIds)]) {
    if (await inTx(ctx.db, (tx) => setOrderOwner(tx, ctx, orderId, null, { kind: 'pool', note: input.note }))) changed++;
  }
  return { changed };
}

export interface TransferInput {
  fromUserId: string;
  toUserId: string;
  /** Limit the transfer to these orders. Omit to move everything the person owns. */
  orderIds?: string[];
  /** When moving everything: skip orders that are lost, cancelled or already handed over. */
  onlyOpen?: boolean;
}

/** Moves a salesperson's orders to a colleague, e.g. when they leave or go on holiday. */
export async function transferOrders(ctx: Ctx, input: TransferInput): Promise<{ changed: number }> {
  requireAssigner(ctx);
  if (input.fromUserId === input.toUserId) throw new ValidationError('Choose two different people.');
  await requireAssignableUser(ctx.db, input.toUserId);
  const orders = await ctx.db.order.findMany({
    where: {
      ownerId: input.fromUserId,
      ...(input.orderIds ? { id: { in: input.orderIds } } : {}),
      ...(input.onlyOpen && !input.orderIds ? { sideState: { in: ['NONE', 'ON_HOLD'] }, stage: { notIn: OPERATIONS_STAGES } } : {}),
    },
    select: { id: true },
  });
  let changed = 0;
  for (const { id } of orders) {
    if (await inTx(ctx.db, (tx) => setOrderOwner(tx, ctx, id, input.toUserId, { kind: 'assign' }))) changed++;
  }
  return { changed };
}
