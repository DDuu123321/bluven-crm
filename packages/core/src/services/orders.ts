// Helpers shared by every service that reads or changes an order: locking, access checks,
// stage derivation and the idle clock.
import { Prisma, type DbOrTx, type OrderStage, type SideState, type Tx } from '@bluven/db';
import { nowOf, type Ctx } from '../context';
import {
  STAGE_LABEL,
  can,
  deriveStage,
  isOrderStaff,
  isSalesEditableStage,
  isWithOperations,
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
  /** When the salesperson opened the job. Null: nobody has taken it up yet. */
  openedAt: Date | null;
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
      openedAt: true,
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

/**
 * Locks the order and requires the actor to be its salesperson, a manager, or the system.
 * `what` names the thing the caller asked for (a quote, a document…), so that something on an
 * order the actor may not see is reported exactly like something that does not exist.
 */
export async function lockOrderForStaff(tx: Tx, ctx: Ctx, orderId: string, what = 'Order'): Promise<OrderState> {
  await lockOrder(tx, orderId);
  const order = (await loadOrderState(tx, orderId))!;
  if (ctx.actor.kind === 'user') {
    if (!orderViewFor(ctx.actor, accessFacts(order))) throw new NotFoundError(`${what} not found.`);
    if (!isOrderStaff(ctx.actor, order)) throw new ForbiddenError('Only the salesperson for this order or a manager can do this.');
  }
  return order;
}

/** Why the order's content cannot be changed right now, or null when it can. */
export function editBlockReason(o: Pick<OrderState, 'stage' | 'sideState'>): string | null {
  if (o.sideState === 'LOST') return 'This order is marked as lost. A manager can restore it.';
  if (o.sideState === 'CANCELLED') return 'This order has been cancelled.';
  if (o.stage === 'PUSHED') return 'This order is waiting for operations. It can be changed again if they return it.';
  if (isWithOperations(o.stage)) return 'Operations has accepted this order. It can no longer be changed here.';
  return isSalesEditableStage(o.stage) ? null : 'This order cannot be changed in its current stage.';
}

/**
 * Why the order cannot be worked on right now, or null when it can. Working on an order (calls
 * and notes, files, the design, the proposal, the deposit) needs more than correcting its
 * details does: the salesperson has to have opened the job, which is when they say where the
 * customer came from.
 */
export function workBlockReason(o: Pick<OrderState, 'stage' | 'sideState' | 'openedAt'>): string | null {
  return editBlockReason(o) ?? (o.openedAt ? null : 'Open the job first. Until then it is only a lead.');
}

/**
 * Cheap gate for endpoints that receive files: fails before a single byte of the body is read
 * when the actor could not change the order anyway. The same checks run again under the row lock
 * when the change is actually made.
 */
export async function requireEditableOrder(ctx: Ctx, orderId: string, what = 'Order'): Promise<OrderState> {
  return requireOrderThat(editBlockReason, ctx, orderId, what);
}

/** The same gate for endpoints that take in work on the order: the job has to be open as well. */
export async function requireWorkableOrder(ctx: Ctx, orderId: string, what = 'Order'): Promise<OrderState> {
  return requireOrderThat(workBlockReason, ctx, orderId, what);
}

async function requireOrderThat(blockReason: (o: OrderState) => string | null, ctx: Ctx, orderId: string, what: string): Promise<OrderState> {
  const order = await loadOrderState(ctx.db, orderId);
  if (!order) throw new NotFoundError(`${what} not found.`);
  if (ctx.actor.kind === 'user') {
    if (!orderViewFor(ctx.actor, accessFacts(order))) throw new NotFoundError(`${what} not found.`);
    if (!isOrderStaff(ctx.actor, order)) throw new ForbiddenError('Only the salesperson for this order or a manager can do this.');
  }
  const reason = blockReason(order);
  if (reason) throw new ConflictError(reason);
  return order;
}

/** Like lockOrderForStaff, and additionally requires the order to be in an editable state. */
export async function lockOrderForEdit(tx: Tx, ctx: Ctx, orderId: string, what = 'Order'): Promise<OrderState> {
  const order = await lockOrderForStaff(tx, ctx, orderId, what);
  const reason = editBlockReason(order);
  if (reason) throw new ConflictError(reason);
  return order;
}

/** Like lockOrderForEdit, and additionally requires the job to have been opened. */
export async function lockOrderForWork(tx: Tx, ctx: Ctx, orderId: string, what = 'Order'): Promise<OrderState> {
  const order = await lockOrderForStaff(tx, ctx, orderId, what);
  const reason = workBlockReason(order);
  if (reason) throw new ConflictError(reason);
  return order;
}

/**
 * Why operations cannot add files to the order right now, or null when they can: from the push
 * until the job is closed. Once an order is theirs they chase what is missing themselves, so
 * they need somewhere to put it. While it is back with sales, the folder is the salesperson's.
 */
export function opsFolderBlockReason(o: Pick<OrderState, 'stage' | 'sideState' | 'firstPushedAt'>): string | null {
  if (!o.firstPushedAt) return 'This order has not been pushed to operations.';
  if (o.sideState === 'CANCELLED') return 'This order has been cancelled.';
  if (o.sideState !== 'NONE') return 'This order is not active.';
  if (o.stage === 'PUSHED' || o.stage === 'IN_PROGRESS' || o.stage === 'INSTALLED') return null;
  return o.stage === 'COMPLETED' ? 'This job is closed.' : 'This order is back with sales.';
}

/** In which capacity somebody adds to an order's folder: selling it, or as operations while the order is with them. */
export type FolderRole = 'STAFF' | 'OPS';

function folderRoleOf(ctx: Ctx, order: OrderState, what: string): FolderRole {
  if (ctx.actor.kind !== 'user') {
    const reason = workBlockReason(order);
    if (reason) throw new ConflictError(reason);
    return 'STAFF';
  }
  if (!orderViewFor(ctx.actor, accessFacts(order))) throw new NotFoundError(`${what} not found.`);
  const staff = isOrderStaff(ctx.actor, order);
  const ops = can(ctx.actor, 'ops.handoffs');
  if (!staff && !ops) throw new ForbiddenError('Only the people working on this order can add files to it.');
  const staffReason = staff ? workBlockReason(order) : null;
  if (staff && !staffReason) return 'STAFF';
  const opsReason = ops ? opsFolderBlockReason(order) : null;
  if (ops && !opsReason) return 'OPS';
  throw new ConflictError((staff ? staffReason : opsReason)!);
}

/**
 * Gate for adding a file to an order's folder, before the upload is read: the salesperson or a
 * manager while the order is theirs to work on, operations while it is with them.
 */
export async function requireFolderAccess(ctx: Ctx, orderId: string, what = 'Order'): Promise<{ order: OrderState; role: FolderRole }> {
  const order = await loadOrderState(ctx.db, orderId);
  if (!order) throw new NotFoundError(`${what} not found.`);
  return { order, role: folderRoleOf(ctx, order, what) };
}

/** The same check under the row lock, when the file is actually added. */
export async function lockOrderForFolder(tx: Tx, ctx: Ctx, orderId: string, what = 'Order'): Promise<{ order: OrderState; role: FolderRole }> {
  await lockOrder(tx, orderId);
  const order = (await loadOrderState(tx, orderId))!;
  return { order, role: folderRoleOf(ctx, order, what) };
}

/** The design has started: recorded once, the first time anything says so. The caller holds the order lock and syncs the stage. */
export async function markDesignStarted(tx: Tx, ctx: Ctx, orderId: string): Promise<void> {
  await tx.order.updateMany({ where: { id: orderId, designAt: null }, data: { designAt: nowOf(ctx) } });
}

/** Recomputes the stage from the recorded facts and stores it. Logs a timeline entry on change. */
export async function syncOrderStage(tx: Tx, ctx: Ctx, orderId: string): Promise<OrderStage> {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      customerId: true,
      stage: true,
      openedAt: true,
      designAt: true,
      quotedAt: true,
      jobDoneAt: true,
      completedAt: true,
      depositAt: true,
      deposits: { where: { status: { in: ['PENDING', 'CONFIRMED'] } }, orderBy: { submittedAt: 'desc' }, select: { status: true, submittedAt: true } },
      handoffs: { orderBy: { version: 'desc' }, take: 1, select: { decision: true } },
    },
  });
  const depositStatuses = o.deposits.map((d) => d.status);
  const decision = o.handoffs[0]?.decision;
  const facts: StageFacts = {
    opened: !!o.openedAt,
    designing: !!o.designAt,
    proposalSent: !!o.quotedAt,
    deposit: depositStatuses.includes('CONFIRMED') ? 'CONFIRMED' : depositStatuses.includes('PENDING') ? 'PENDING' : 'NONE',
    handoff: !decision || decision === 'WITHDRAWN' ? 'NONE' : decision,
    jobDone: !!o.jobDoneAt,
    completed: !!o.completedAt,
  };
  // The day the sale counts from follows the deposit record: there while one is on file, gone when it is withdrawn.
  const depositAt = o.deposits[0]?.submittedAt ?? null;
  if ((o.depositAt?.getTime() ?? null) !== (depositAt?.getTime() ?? null)) await tx.order.update({ where: { id: orderId }, data: { depositAt } });
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
 * emails, finance, operations and the system never do. And only work on the deal counts: opening
 * the job, a call or note, a file, a quote, the deposit, a push, a completed task. Planning (adding
 * or moving tasks) and record keeping (correcting contact details or the address, notes for
 * operations, re-filing a document) do not, or an order could be kept "active" for ever without
 * anyone speaking to the customer.
 */
export async function touchStaffActivity(tx: Tx, ctx: Ctx, order: Pick<OrderState, 'id' | 'ownerId'>): Promise<void> {
  if (ctx.actor.kind !== 'user' || !isOrderStaff(ctx.actor, order)) return;
  await tx.order.update({ where: { id: order.id }, data: { lastStaffActivityAt: nowOf(ctx), idleLevel: 0 } });
  // The "no activity" task has done its job.
  await tx.task.updateMany({ where: { orderId: order.id, kind: 'IDLE', status: 'OPEN' }, data: { status: 'DONE', completedAt: nowOf(ctx), completedById: ctx.actor.id } });
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
