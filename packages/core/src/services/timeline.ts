// Manual timeline entries (notes, calls, meetings, messages) and follow-up tasks.
import type { Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { isManager, isOrderStaff } from '../domain';
import { ConflictError, FieldErrors, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit } from './audit';
import { accessFacts, lockOrderForStaff, loadOrderState, syncOrderStage, touchStaffActivity } from './orders';

export const LOGGABLE_TYPES = ['NOTE', 'CALL', 'MEETING', 'MESSAGE'] as const;
export type LoggableType = (typeof LOGGABLE_TYPES)[number];

export const CALL_OUTCOMES = ['connected', 'no_answer', 'voicemail'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  connected: 'spoke with customer',
  no_answer: 'no answer',
  voicemail: 'left a voicemail',
};

export interface LogActivityInput {
  orderId: string;
  type: string;
  /** What was said or done. */
  body: string;
  /** When it happened; defaults to now. */
  occurredAt?: Date | null;
  /** Calls only. */
  outcome?: string | null;
  direction?: string | null;
}

/**
 * Adds a manual entry to the timeline. Calls, meetings and messages count as contact with the
 * customer and move a new order to "Contacted".
 */
export async function logActivity(ctx: Ctx, input: LogActivityInput): Promise<{ id: string }> {
  const errors = new FieldErrors();
  const type = (LOGGABLE_TYPES as readonly string[]).includes(input.type) ? (input.type as LoggableType) : null;
  if (!type) errors.add('type', 'Choose what kind of entry this is.');
  const body = input.body.trim();
  if (!body) errors.add('body', 'Write what happened.');
  if (body.length > 10_000) errors.add('body', 'Use at most 10,000 characters.');
  const now = nowOf(ctx);
  const occurredAt = input.occurredAt ?? now;
  if (occurredAt.getTime() > now.getTime() + 5 * 60_000) errors.add('occurredAt', 'This cannot be in the future.');
  const outcome = type === 'CALL' && (CALL_OUTCOMES as readonly string[]).includes(input.outcome ?? '') ? (input.outcome as CallOutcome) : null;
  if (type === 'CALL' && !outcome) errors.add('outcome', 'Choose how the call went.');
  const direction = input.direction === 'inbound' ? 'inbound' : 'outbound';
  errors.throwIfAny();

  return inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    // Notes stay possible in every later state, but a lead nobody has opened is not being worked on yet.
    if (!order.openedAt) throw new ConflictError('Open the job first. Until then it is only a lead.');
    const summary =
      type === 'NOTE'
        ? 'Note'
        : type === 'CALL'
          ? `${direction === 'inbound' ? 'Incoming' : 'Outgoing'} call: ${CALL_OUTCOME_LABEL[outcome!]}`
          : type === 'MEETING'
            ? 'Meeting or site visit'
            : 'Message (SMS, WhatsApp or similar)';
    const id = await addActivity(tx, ctx, {
      customerId: order.customerId,
      orderId: order.id,
      type: type!,
      summary,
      body,
      occurredAt,
      payload: type === 'CALL' ? { outcome, direction } : {},
    });
    if (type !== 'NOTE' && !order.firstContactedAt) {
      await tx.order.update({ where: { id: order.id }, data: { firstContactedAt: occurredAt > now ? now : occurredAt } });
    }
    await touchStaffActivity(tx, ctx, order);
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'activity.log',
      entityType: 'Activity',
      entityId: id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: logged ${summary.toLowerCase()}`,
      after: { type, occurredAt, outcome, direction: type === 'CALL' ? direction : undefined, body },
    });
    return { id };
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  orderId: string;
  title: string;
  dueAt: Date | null;
  notes?: string;
}

export async function createTask(ctx: Ctx, input: CreateTaskInput): Promise<{ id: string }> {
  const errors = new FieldErrors();
  const title = input.title.trim();
  if (!title) errors.add('title', 'Say what needs to be done.');
  if (title.length > 200) errors.add('title', 'Use at most 200 characters.');
  if (!input.dueAt) errors.add('dueAt', 'Choose when this is due.');
  errors.throwIfAny();

  return inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    const id = newId('tsk');
    await tx.task.create({
      data: {
        id,
        orderId: order.id,
        assigneeId: order.ownerId,
        title,
        notes: (input.notes ?? '').trim().slice(0, 2000),
        dueAt: input.dueAt!,
        createdById: ctx.actor.kind === 'user' ? ctx.actor.id : null,
        createdAt: nowOf(ctx),
      },
    });
    // Adding or moving a task does not restart the idle clock: only work on the order does
    // (a call, a note, a file, a quote, a completed task). A lead that should wait is put on hold.
    await audit(tx, ctx, {
      action: 'task.create',
      entityType: 'Task',
      entityId: id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: added task “${title}”`,
      after: { title, dueAt: input.dueAt, assigneeId: order.ownerId },
    });
    return { id };
  });
}

/**
 * Closes the open tasks the system raised for a problem that has just been dealt with, for
 * example "deposit rejected: resubmit" once a new submission is in. Without this they would sit
 * in the task list, overdue, long after the order has moved on.
 */
export async function completeSystemTasks(tx: Tx, ctx: Ctx, orderId: string, kinds: string[]): Promise<void> {
  await tx.task.updateMany({
    where: { orderId, status: 'OPEN', kind: { in: kinds } },
    data: { status: 'DONE', completedAt: nowOf(ctx), completedById: ctx.actor.kind === 'user' ? ctx.actor.id : null },
  });
}

async function loadTaskForStaff(ctx: Ctx, taskId: string) {
  const task = await ctx.db.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError('Task not found.');
  const order = await loadOrderState(ctx.db, task.orderId);
  if (!order) throw new NotFoundError('Task not found.');
  if (ctx.actor.kind === 'user') {
    const staff = isOrderStaff(ctx.actor, accessFacts(order));
    if (!staff) throw isManager(ctx.actor) ? new ForbiddenError() : new NotFoundError('Task not found.');
  }
  return task;
}

export async function setTaskStatus(ctx: Ctx, input: { taskId: string; status: 'DONE' | 'CANCELLED' | 'OPEN' }): Promise<void> {
  const task = await loadTaskForStaff(ctx, input.taskId);
  if (task.status === input.status) return;
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, task.orderId);
    const now = nowOf(ctx);
    await tx.task.update({
      where: { id: task.id },
      data: {
        status: input.status,
        completedAt: input.status === 'DONE' ? now : null,
        completedById: input.status === 'DONE' && ctx.actor.kind === 'user' ? ctx.actor.id : null,
        remindedAt: input.status === 'OPEN' ? null : task.remindedAt,
        // A reopened task belongs to whoever looks after the order today, not to whoever had it then.
        ...(input.status === 'OPEN' ? { assigneeId: order.ownerId } : {}),
      },
    });
    if (input.status === 'DONE') {
      await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'TASK', summary: `Completed task: ${task.title}` });
      await touchStaffActivity(tx, ctx, order);
    }
    await audit(tx, ctx, {
      action: 'task.status',
      entityType: 'Task',
      entityId: task.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: task “${task.title}” is now ${input.status.toLowerCase()}`,
      before: { status: task.status },
      after: { status: input.status },
    });
  });
}

export async function updateTask(ctx: Ctx, input: { taskId: string; title: string; dueAt: Date | null; notes: string }): Promise<void> {
  const task = await loadTaskForStaff(ctx, input.taskId);
  const title = input.title.trim();
  if (!title) throw new ValidationError('Say what needs to be done.', { title: 'Say what needs to be done.' });
  if (!input.dueAt) throw new ValidationError('Choose when this is due.', { dueAt: 'Choose when this is due.' });
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, task.orderId);
    const dueChanged = task.dueAt.getTime() !== input.dueAt!.getTime();
    await tx.task.update({
      where: { id: task.id },
      data: { title: title.slice(0, 200), dueAt: input.dueAt!, notes: input.notes.trim().slice(0, 2000), remindedAt: dueChanged ? null : task.remindedAt },
    });
    await audit(tx, ctx, {
      action: 'task.update',
      entityType: 'Task',
      entityId: task.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: updated task “${title}”`,
      before: { title: task.title, dueAt: task.dueAt, notes: task.notes },
      after: { title, dueAt: input.dueAt, notes: input.notes.trim() },
    });
  });
}
