// Helpers shared by every service that reads or changes an order: locking, access checks,
// stage derivation and the idle clock.
import { Prisma, type DbOrTx, type OrderStage, type SideState, type Tx } from '@bluven/db';
import { nowOf, type Ctx } from '../context';
import {
  STAGE_LABEL,
  deriveStage,
  isOrderStaff,
  isSalesEditableStage,
  localDateString,
  orderViewFor,
  type OrderAccessFacts,
  type OrderView,
  type StageFacts,
} from '../domain';
import { getConfig } from '../config';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors';
import { addActivity } from './activity';
import { audit } from './audit';

/** The slice of an order that access checks and state rules need. */
export interface OrderState {
  id: string;
  orderNo: string;
  customerId: string;
  propertyId: string;
  ownerId: string | null;
  stage: OrderStage;
  sideState: SideState;
  firstPushedAt: Date | null;
  firstContactedAt: Date | null;
  quotedAt: Date | null;
  hasDepositRecord: boolean;
  /** State of the open deposit: rejected and withdrawn deposits count as NONE. */
  deposit: StageFacts['deposit'];
}

export async function loadOrderState(db: DbOrTx, orderId: string): Promise<OrderState | null> {
  const o = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNo: true,
      customerId: true,
      propertyId: true,
      ownerId: true,
      stage: true,
      sideState: true,
      firstPushedAt: true,
      firstContactedAt: true,
      quotedAt: true,
      deposits: { select: { status: true } },
    },
  });
  if (!o) return null;
  const statuses = o.deposits.map((d) => d.status);
  const { deposits: _deposits, ...rest } = o;
  return {
    ...rest,
    hasDepositRecord: statuses.length > 0,
    deposit: statuses.includes('CONFIRMED') ? 'CONFIRMED' : statuses.includes('PENDING') ? 'PENDING' : 'NONE',
  };
}

export function accessFacts(o: OrderState): OrderAccessFacts {
  return {
    ownerId: o.ownerId,
    stage: o.stage,
    sideState: o.sideState,
    firstPushedAt: o.firstPushedAt,
    hasDepositRecord: o.hasDepositRecord,
  };
}

/** Row-locks the order for the rest of the transaction so concurrent changes are serialised. */
export async function lockOrder(tx: Tx, orderId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
  if (rows.length === 0) throw new NotFoundError('Order not found.');
}

/**
 * Loads the order and the view the actor is entitled to. Orders the actor may not see are
 * reported as not found, so their existence is not revealed.
 */
export async function requireOrderView(db: DbOrTx, ctx: Ctx, orderId: string): Promise<{ order: OrderState; view: OrderView }> {
  const order = await loadOrderState(db, orderId);
  if (!order) throw new NotFoundError('Order not found.');
  if (ctx.actor.kind === 'system') return { order, view: 'FULL' };
  const view = orderViewFor(ctx.actor, accessFacts(order));
  if (!view) throw new NotFoundError('Order not found.');
  return { order, view };
}

/** Locks the order and requires the actor to be its salesperson, a manager, or the system. */
export async function lockOrderForStaff(tx: Tx, ctx: Ctx, orderId: string): Promise<OrderState> {
  await lockOrder(tx, orderId);
  const order = (await loadOrderState(tx, orderId))!;
  if (ctx.actor.kind === 'user') {
    if (!orderViewFor(ctx.actor, accessFacts(order))) throw new NotFoundError('Order not found.');
    if (!isOrderStaff(ctx.actor, order)) throw new ForbiddenError('Only the salesperson for this order or a manager can do this.');
  }
  return order;
}

/** Why the order's content cannot be changed right now, or null when it can. */
export function editBlockReason(o: Pick<OrderState, 'stage' | 'sideState'>): string | null {
  if (o.sideState === 'LOST') return 'This order is marked as lost. A manager can restore it.';
  if (o.sideState === 'CANCELLED') return 'This order has been cancelled.';
  if (o.stage === 'PUSHED') return 'This order is with operations. It can be changed again if they return it.';
  if (o.stage === 'HANDED_OVER') return 'This order has been handed over to operations and can no longer be changed here.';
  return isSalesEditableStage(o.stage) ? null : 'This order cannot be changed in its current stage.';
}

/** Like lockOrderForStaff, and additionally requires the order to be in an editable state. */
export async function lockOrderForEdit(tx: Tx, ctx: Ctx, orderId: string): Promise<OrderState> {
  const order = await lockOrderForStaff(tx, ctx, orderId);
  const reason = editBlockReason(order);
  if (reason) throw new ConflictError(reason);
  return order;
}

/** Recomputes the stage from the recorded facts and stores it. Logs a timeline entry on change. */
export async function syncOrderStage(tx: Tx, ctx: Ctx, orderId: string): Promise<OrderStage> {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      customerId: true,
      stage: true,
      firstContactedAt: true,
      quotedAt: true,
      contracts: { where: { voidedAt: null }, select: { id: true }, take: 1 },
      deposits: { where: { status: { in: ['PENDING', 'CONFIRMED'] } }, select: { status: true } },
      handoffs: { orderBy: { version: 'desc' }, take: 1, select: { decision: true } },
    },
  });
  const depositStatuses = o.deposits.map((d) => d.status);
  const decision = o.handoffs[0]?.decision;
  const facts: StageFacts = {
    contacted: !!o.firstContactedAt,
    quoted: !!o.quotedAt,
    hasContract: o.contracts.length > 0,
    deposit: depositStatuses.includes('CONFIRMED') ? 'CONFIRMED' : depositStatuses.includes('PENDING') ? 'PENDING' : 'NONE',
    handoff: !decision || decision === 'WITHDRAWN' ? 'NONE' : decision,
  };
  const next = deriveStage(facts);
  if (next !== o.stage) {
    await tx.order.update({ where: { id: orderId }, data: { stage: next } });
    const summary = `Stage changed from ${STAGE_LABEL[o.stage]} to ${STAGE_LABEL[next]}`;
    await addActivity(tx, ctx, { customerId: o.customerId, orderId, type: 'STAGE_CHANGE', summary, payload: { from: o.stage, to: next } });
    await audit(tx, ctx, {
      action: 'order.stage',
      entityType: 'Order',
      entityId: orderId,
      orderId,
      customerId: o.customerId,
      summary,
      before: { stage: o.stage },
      after: { stage: next },
    });
  }
  return next;
}

/**
 * Resets the idle clock. Only actions by the order's salesperson or a manager count: customer
 * emails, finance, operations and the system never do.
 */
export async function touchStaffActivity(tx: Tx, ctx: Ctx, order: Pick<OrderState, 'id' | 'ownerId'>): Promise<void> {
  if (ctx.actor.kind !== 'user' || !isOrderStaff(ctx.actor, order)) return;
  await tx.order.update({ where: { id: order.id }, data: { lastStaffActivityAt: nowOf(ctx), idleLevel: 0 } });
}

/** Allocates the next order number of the current year, e.g. BLV-2026-00123. */
export async function nextOrderNo(tx: Tx, now: Date): Promise<string> {
  const year = localDateString(now, getConfig().timeZone).slice(0, 4);
  const key = `orderNo:${year}`;
  const rows = await tx.$queryRaw<{ value: number }[]>(Prisma.sql`
    INSERT INTO "Counter" ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1
    RETURNING "value"`);
  return `BLV-${year}-${String(rows[0]!.value).padStart(5, '0')}`;
}

/** In-app path of an order page. */
export function orderHref(orderId: string): string {
  return `/orders/${orderId}`;
}
