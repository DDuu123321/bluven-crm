// What operations does with an order after accepting it: keeping the record of what has been
// arranged, telling the customer the dates, marking the job as done, and closing it when the
// final payment has arrived. Sales and managers read all of it and change none of it.
import type { Db, OpsJob, Tx } from '@bluven/db';
import { inTx, nowOf, systemCtx, type Ctx, type UserActor } from '../context';
import { getConfig } from '../config';
import {
  CA_STATUSES,
  DELIVERY_MODES,
  PURCHASE_STATUSES,
  STC_PLATFORMS,
  addWorkingDays,
  can,
  formatAddress,
  formatCents,
  formatDateOnly,
  fullName,
  isWithOperations,
  opsItems,
  todayDateOnly,
  workingDaysBetween,
  type OpsItem,
  type OrderStage,
} from '../domain';
import { ConflictError, FieldErrors, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit, diff } from './audit';
import { withJobLock } from './jobs';
import { getOperationsSettings, listNotices, queueNotice, type NoticeView, type QueueOutcome } from './notices';
import { managerIds, notifyRoles, notifyUsers } from './notify';
import { lockOrder, loadOrderState, orderHref, requireOrderView, syncOrderStage, type OrderState } from './orders';
import { completeSystemTasks } from './timeline';

function requireOps(ctx: Ctx): UserActor {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'ops.handoffs')) throw new ForbiddenError('Only operations can do this.');
  return ctx.actor;
}

const NOT_IN_STAGE: Partial<Record<OrderStage, string>> = {
  PUSHED: 'Accept the order first.',
  RETURNED: 'This order is back with sales.',
  INSTALLED: 'The job is already marked as done.',
  COMPLETED: 'This job is closed.',
};

/** Locks an order operations has accepted and checks that it is in one of the given stages. */
async function lockForOperations(tx: Tx, orderId: string, stages: OrderStage[]): Promise<OrderState> {
  await lockOrder(tx, orderId);
  const order = await loadOrderState(tx, orderId);
  if (!order || !order.firstPushedAt) throw new NotFoundError('Order not found.');
  if (order.sideState !== 'NONE') throw new ConflictError(`This order is ${order.sideState === 'CANCELLED' ? 'cancelled' : 'not active'}.`);
  if (!stages.includes(order.stage)) throw new ConflictError(NOT_IN_STAGE[order.stage] ?? 'This order is not with operations.');
  return order;
}

// ---------------------------------------------------------------------------
// The record of what has been arranged
// ---------------------------------------------------------------------------

export interface OpsJobInput {
  orderId: string;
  caStatus: string;
  caReference: string;
  /** Empty: not assigned yet. */
  stcPlatform: string;
  stcReference: string;
  installerName: string;
  electricianLicence: string;
  installDate: Date | null;
  /** Empty: not arranged yet. */
  deliveryMode: string;
  deliveryEta: Date | null;
  purchaseStatus: string;
}

const JOB_FIELDS = ['caStatus', 'caReference', 'stcPlatform', 'stcReference', 'installerName', 'electricianLicence', 'installDate', 'deliveryMode', 'deliveryEta', 'purchaseStatus'] as const;
type JobFields = Pick<OpsJob, (typeof JOB_FIELDS)[number]>;

/**
 * Saves what operations has arranged for the job. The items stand side by side: any of them
 * can be filled in at any time, and saving changes only what is different. The salesperson is
 * told when the installation date is set or moved, because the customer will ask them.
 */
export async function updateOpsJob(ctx: Ctx, input: OpsJobInput): Promise<void> {
  const actor = requireOps(ctx);
  const errors = new FieldErrors();
  const oneOf = <T extends string>(list: readonly T[], value: string): T | null => ((list as readonly string[]).includes(value) ? (value as T) : null);
  const caStatus = oneOf(CA_STATUSES, input.caStatus);
  if (!caStatus) errors.add('caStatus', 'Choose how the connection approval stands.');
  const stcPlatform = input.stcPlatform ? oneOf(STC_PLATFORMS, input.stcPlatform) : null;
  if (input.stcPlatform && !stcPlatform) errors.add('stcPlatform', 'Choose a platform.');
  const deliveryMode = input.deliveryMode ? oneOf(DELIVERY_MODES, input.deliveryMode) : null;
  if (input.deliveryMode && !deliveryMode) errors.add('deliveryMode', 'Choose how the equipment gets to the site.');
  const purchaseStatus = oneOf(PURCHASE_STATUSES, input.purchaseStatus);
  if (!purchaseStatus) errors.add('purchaseStatus', 'Choose how the stock stands.');
  const short = (field: string, value: string, max: number): string => {
    const text = value.trim();
    if (text.length > max) errors.add(field, `Use at most ${max} characters.`);
    return text;
  };
  const next: JobFields = {
    caStatus: caStatus ?? 'TODO',
    caReference: short('caReference', input.caReference, 100),
    stcPlatform,
    stcReference: stcPlatform ? short('stcReference', input.stcReference, 100) : '',
    installerName: short('installerName', input.installerName, 100),
    electricianLicence: short('electricianLicence', input.electricianLicence, 50),
    installDate: input.installDate,
    deliveryMode,
    // A day of arrival only means something for a delivery.
    deliveryEta: deliveryMode === 'DELIVERY' ? input.deliveryEta : null,
    purchaseStatus: purchaseStatus ?? 'UNDECIDED',
  };
  errors.throwIfAny();

  await inTx(ctx.db, async (tx) => {
    const order = await lockForOperations(tx, input.orderId, ['IN_PROGRESS', 'INSTALLED']);
    const job = await tx.opsJob.findUniqueOrThrow({ where: { orderId: order.id } });
    const before = Object.fromEntries(JOB_FIELDS.map((f) => [f, job[f]])) as JobFields;
    const change = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (!change) return;
    await tx.opsJob.update({ where: { orderId: order.id }, data: { ...next, updatedById: actor.id } });
    // The timeline shows the items that read differently now, in the words the page uses.
    const was = new Map(opsItems(before).map((i) => [i.key, i.detail]));
    const changed = opsItems(next).filter((i) => was.get(i.key) !== i.detail);
    await addActivity(tx, ctx, {
      customerId: order.customerId,
      orderId: order.id,
      type: 'HANDOFF',
      summary: 'Operations updated the job',
      body: changed.map((i) => `${i.label}: ${i.detail}`).join('\n'),
      payload: { items: changed.map((i) => i.key) },
    });
    await audit(tx, ctx, { action: 'ops.update', entityType: 'OpsJob', entityId: order.id, orderId: order.id, customerId: order.customerId, summary: `${order.orderNo}: operations updated the job`, ...change });
    const dateChanged = (before.installDate?.getTime() ?? null) !== (next.installDate?.getTime() ?? null);
    if (dateChanged && next.installDate) {
      await notifyUsers(tx, ctx, [order.ownerId], {
        type: 'ops.install_date',
        title: `${order.orderNo}: installation ${before.installDate ? 'moved to' : 'booked for'} ${formatDateOnly(next.installDate)}`,
        href: orderHref(order.id),
        orderId: order.id,
        inAppOnly: true,
      });
    }
  });
}

/** A note by operations about the job, for everyone who can see the order. */
export async function addOpsNote(ctx: Ctx, input: { orderId: string; body: string }): Promise<void> {
  requireOps(ctx);
  const body = input.body.trim();
  if (!body) throw new ValidationError('Write the note.', { body: 'Write the note.' });
  if (body.length > 10_000) throw new ValidationError('Use at most 10,000 characters.', { body: 'Use at most 10,000 characters.' });
  await inTx(ctx.db, async (tx) => {
    await lockOrder(tx, input.orderId);
    const order = await loadOrderState(tx, input.orderId);
    if (!order || !order.firstPushedAt) throw new NotFoundError('Order not found.');
    const id = await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'NOTE', summary: 'Note from operations', body, payload: { opsNote: true } });
    await audit(tx, ctx, { action: 'activity.log', entityType: 'Activity', entityId: id, orderId: order.id, customerId: order.customerId, summary: `${order.orderNo}: operations added a note`, after: { body } });
  });
}

/**
 * Tells the customer when the installation is and how the equipment arrives. Operations sends
 * it when both are settled, and again when either has changed.
 */
export async function sendScheduleNotice(ctx: Ctx, input: { orderId: string }): Promise<QueueOutcome> {
  requireOps(ctx);
  return inTx(ctx.db, async (tx) => {
    const order = await lockForOperations(tx, input.orderId, ['IN_PROGRESS']);
    const job = await tx.opsJob.findUniqueOrThrow({ where: { orderId: order.id } });
    const items = opsItems(job);
    const open = items.filter((i) => (i.key === 'installDate' || i.key === 'delivery') && !i.done);
    if (open.length > 0) throw new ConflictError(`Fill in the ${open.map((i) => i.label.toLowerCase()).join(' and the ')} first: that is what this e-mail tells the customer.`);
    if (await tx.customerNotice.findFirst({ where: { orderId: order.id, kind: 'SCHEDULE', status: 'PENDING' }, select: { id: true } })) {
      throw new ConflictError('The dates e-mail is already waiting to be sent.');
    }
    const outcome = await queueNotice(tx, ctx, order.id, 'SCHEDULE');
    if (outcome === 'off') throw new ConflictError('The dates e-mail is switched off in the settings.');
    await audit(tx, ctx, { action: 'notice.queue', entityType: 'Order', entityId: order.id, orderId: order.id, customerId: order.customerId, summary: `${order.orderNo}: dates e-mail to the customer queued`, after: { installDate: job.installDate, deliveryMode: job.deliveryMode, deliveryEta: job.deliveryEta } });
    return outcome;
  });
}

// ---------------------------------------------------------------------------
// Job done, the balance and the rebate
// ---------------------------------------------------------------------------

/**
 * Operations marks the installation as done. The customer is thanked and asked for the balance,
 * the salesperson and the managers are told, and the clocks for the two reminders start: to
 * apply for the rebate, and to look whether the balance has come in.
 */
export async function markJobDone(ctx: Ctx, input: { orderId: string }): Promise<void> {
  const actor = requireOps(ctx);
  await inTx(ctx.db, async (tx) => {
    const order = await lockForOperations(tx, input.orderId, ['IN_PROGRESS']);
    const now = nowOf(ctx);
    await tx.order.update({ where: { id: order.id }, data: { jobDoneAt: now, jobDoneById: actor.id } });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'HANDOFF', summary: 'Job done' });
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, { action: 'ops.job_done', entityType: 'Order', entityId: order.id, orderId: order.id, customerId: order.customerId, summary: `${order.orderNo}: job done`, after: { jobDoneAt: now } });
    const asked = await queueNotice(tx, ctx, order.id, 'JOB_DONE');
    await notifyUsers(tx, ctx, [order.ownerId, ...(await managerIds(tx))], {
      type: 'ops.job_done',
      title: `${order.orderNo}: the installation is done`,
      body: asked === 'queued' ? 'The customer is being thanked and asked for the balance.' : 'The balance is due now.',
      href: orderHref(order.id),
      orderId: order.id,
    });
  });
}

/** Operations records that the rebate has been applied for, or takes that back. */
export async function setRebateApplied(ctx: Ctx, input: { orderId: string; applied: boolean }): Promise<void> {
  const actor = requireOps(ctx);
  await inTx(ctx.db, async (tx) => {
    const order = await lockForOperations(tx, input.orderId, ['INSTALLED', 'COMPLETED']);
    const job = await tx.opsJob.findUniqueOrThrow({ where: { orderId: order.id } });
    if (!!job.rebateAppliedAt === input.applied) return;
    const now = nowOf(ctx);
    await tx.opsJob.update({ where: { orderId: order.id }, data: { rebateAppliedAt: input.applied ? now : null, rebateAppliedById: input.applied ? actor.id : null, updatedById: actor.id } });
    const summary = input.applied ? 'Rebate applied for' : 'Rebate marked as not applied for yet';
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'HANDOFF', summary });
    await audit(tx, ctx, { action: 'ops.rebate', entityType: 'OpsJob', entityId: order.id, orderId: order.id, customerId: order.customerId, summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`, after: { applied: input.applied } });
  });
}

/** Who may say that money has arrived: operations and finance, the people who see the account. */
function requireAccountAccess(ctx: Ctx): UserActor {
  if (ctx.actor.kind !== 'user' || !(can(ctx.actor, 'ops.handoffs') || can(ctx.actor, 'finance.deposits'))) throw new ForbiddenError('Only operations or finance can do this.');
  return ctx.actor;
}

/**
 * The balance has not come in: operations (or finance) hands the chasing to the salesperson,
 * who gets a task for it. Salespeople do not see the account, so they are only asked once
 * someone who does has looked.
 */
export async function askSalesToChaseBalance(ctx: Ctx, input: { orderId: string; note?: string }): Promise<void> {
  const actor = requireAccountAccess(ctx);
  const note = (input.note ?? '').trim().slice(0, 2000);
  await inTx(ctx.db, async (tx) => {
    const order = await lockForOperations(tx, input.orderId, ['INSTALLED']);
    const now = nowOf(ctx);
    if (await tx.task.findFirst({ where: { orderId: order.id, kind: 'BALANCE', status: 'OPEN' }, select: { id: true } })) {
      throw new ConflictError('The salesperson already has an open task to ask for the balance.');
    }
    await tx.opsJob.update({ where: { orderId: order.id }, data: { balanceChaseAskedAt: now, balanceChaseAskedById: actor.id } });
    await tx.task.create({
      data: { id: newId('tsk'), orderId: order.id, assigneeId: order.ownerId, title: 'Ask the customer for the balance', notes: note, dueAt: now, kind: 'BALANCE', remindedAt: now, createdById: actor.id, createdAt: now },
    });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'HANDOFF', summary: 'Sales asked to chase the balance', body: note });
    await audit(tx, ctx, { action: 'ops.balance_chase', entityType: 'Order', entityId: order.id, orderId: order.id, customerId: order.customerId, summary: `${order.orderNo}: sales asked to chase the balance`, after: { note } });
    await notifyUsers(tx, ctx, order.ownerId ? [order.ownerId] : await managerIds(tx), {
      type: 'ops.balance_chase',
      title: `${order.orderNo}: please ask the customer for the balance`,
      body: note || 'The installation is done and the final payment has not arrived.',
      href: orderHref(order.id),
      orderId: order.id,
    });
  });
}

export interface FinalPaymentInput {
  orderId: string;
  /** What arrived. Left out when only the fact is known. */
  amountCents?: number | null;
  receivedOn?: Date | null;
  note?: string;
}

/**
 * The final payment has arrived: operations or finance says so, and the job is closed. Finance
 * is told, as are the salesperson and the managers.
 */
export async function confirmFinalPayment(ctx: Ctx, input: FinalPaymentInput): Promise<void> {
  const actor = requireAccountAccess(ctx);
  const errors = new FieldErrors();
  const now = nowOf(ctx);
  const today = todayDateOnly(now, getConfig().timeZone);
  const amountCents = input.amountCents ?? null;
  if (amountCents !== null && amountCents <= 0) errors.add('amount', 'Enter the amount that arrived, or leave it empty.');
  const receivedOn = input.receivedOn ?? today;
  if (receivedOn > today) errors.add('receivedOn', 'This date cannot be in the future.');
  const note = (input.note ?? '').trim().slice(0, 1000);
  errors.throwIfAny();
  await inTx(ctx.db, async (tx) => {
    const order = await lockForOperations(tx, input.orderId, ['INSTALLED']);
    await tx.order.update({ where: { id: order.id }, data: { completedAt: now, completedById: actor.id } });
    await tx.opsJob.update({ where: { orderId: order.id }, data: { finalAmountCents: amountCents, finalReceivedOn: receivedOn, finalNote: note, updatedById: actor.id } });
    await completeSystemTasks(tx, ctx, order.id, ['BALANCE']);
    const summary = `Final payment${amountCents !== null ? ` of ${formatCents(amountCents)}` : ''} received on ${formatDateOnly(receivedOn)}: job closed`;
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'DEPOSIT', summary, body: note });
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, { action: 'ops.final_payment', entityType: 'Order', entityId: order.id, orderId: order.id, customerId: order.customerId, summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`, after: { amountCents, receivedOn, note } });
    await notifyRoles(tx, ctx, ['FINANCE'], {
      type: 'payment.final',
      title: `Final payment received: ${order.orderNo}${amountCents !== null ? `, ${formatCents(amountCents)}` : ''}`,
      body: 'The job is closed.',
      href: '/finance?tab=closed',
      orderId: order.id,
    });
    await notifyUsers(tx, ctx, [order.ownerId, ...(await managerIds(tx))], {
      type: 'payment.final',
      title: `${order.orderNo}: final payment received, job closed`,
      href: orderHref(order.id),
      orderId: order.id,
    });
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface OperationsView {
  stage: OrderStage;
  items: OpsItem[];
  job: JobFields;
  acceptedAt: Date | null;
  jobDoneAt: Date | null;
  completedAt: Date | null;
  rebate: { appliedAt: Date | null; dueOn: Date | null; overdue: boolean };
  balance: {
    /** The day by which the customer was asked to pay. */
    dueOn: Date | null;
    overdue: boolean;
    chaseAskedAt: Date | null;
    amountCents: number | null;
    receivedOn: Date | null;
    note: string;
  };
  notices: NoticeView[];
  /** The dates e-mail has gone out, or is on its way, with the dates as they stand now. */
  scheduleUpToDate: boolean;
  /** What operations wrote about the job, newest first. */
  notes: { id: string; body: string; at: Date; by: string }[];
}

/**
 * How the job stands with operations, for the people who may see the order: operations
 * themselves, the salesperson and the managers. Null before operations has accepted it.
 */
export async function getOperationsView(ctx: Ctx, orderId: string): Promise<OperationsView | null> {
  const { order, view } = await requireOrderView(ctx.db, ctx, orderId);
  if (view !== 'FULL' && view !== 'OPS') return null;
  const row = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id }, select: { handedOverAt: true, jobDoneAt: true, completedAt: true, opsJob: true } });
  const job = row.opsJob;
  if (!job) return null;
  const settings = await getOperationsSettings(ctx.db);
  const timeZone = getConfig().timeZone;
  const today = todayDateOnly(nowOf(ctx), timeZone);
  const doneOn = row.jobDoneAt ? todayDateOnly(row.jobDoneAt, timeZone) : null;
  const rebateDue = doneOn ? addWorkingDays(doneOn, settings.rebateReminderDays) : null;
  const balanceDue = doneOn ? addWorkingDays(doneOn, settings.balanceDays) : null;
  const notices = await listNotices(ctx.db, order.id);
  const notes = await ctx.db.activity.findMany({
    where: { orderId: order.id, type: 'NOTE', payload: { path: ['opsNote'], equals: true } },
    select: { id: true, body: true, occurredAt: true, actor: { select: { name: true } } },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  const lastSchedule = notices.find((n) => n.kind === 'SCHEDULE' && (n.status === 'SENT' || n.status === 'PENDING'));
  const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
  return {
    stage: order.stage,
    items: opsItems(job),
    job: Object.fromEntries(JOB_FIELDS.map((f) => [f, job[f]])) as JobFields,
    acceptedAt: row.handedOverAt,
    jobDoneAt: row.jobDoneAt,
    completedAt: row.completedAt,
    rebate: { appliedAt: job.rebateAppliedAt, dueOn: rebateDue, overdue: !!rebateDue && !job.rebateAppliedAt && today >= rebateDue },
    balance: {
      dueOn: balanceDue,
      overdue: !!balanceDue && !row.completedAt && today >= balanceDue,
      chaseAskedAt: job.balanceChaseAskedAt,
      amountCents: job.finalAmountCents,
      receivedOn: job.finalReceivedOn,
      note: job.finalNote,
    },
    notices,
    scheduleUpToDate:
      !!lastSchedule && lastSchedule.payload.installDate === day(job.installDate) && (lastSchedule.payload.deliveryMode ?? null) === job.deliveryMode && (lastSchedule.payload.deliveryEta ?? null) === day(job.deliveryEta),
    notes: notes.map((n) => ({ id: n.id, body: n.body, at: n.occurredAt, by: n.actor?.name ?? 'Operations' })),
  };
}

export interface OpsJobRow {
  orderId: string;
  orderNo: string;
  stage: OrderStage;
  customerName: string;
  address: string;
  salesperson: string | null;
  acceptedAt: Date | null;
  /** How many of the items are settled, and which are still open. */
  itemsDone: number;
  itemsTotal: number;
  openItems: string[];
  installDate: Date | null;
  jobDoneAt: Date | null;
  completedAt: Date | null;
  rebateApplied: boolean;
  rebateOverdue: boolean;
  balanceDueOn: Date | null;
  balanceOverdue: boolean;
  chaseAskedAt: Date | null;
}

/**
 * The jobs operations has in one stage: being arranged (soonest installation first, undated ones
 * at the end), installed and waiting for the balance (longest first), or closed (latest first).
 */
export async function listOpsJobs(ctx: Ctx, stage: 'IN_PROGRESS' | 'INSTALLED' | 'COMPLETED'): Promise<OpsJobRow[]> {
  requireOps(ctx);
  const rows = await ctx.db.order.findMany({
    where: { stage, sideState: 'NONE', opsJob: { isNot: null } },
    select: {
      id: true,
      orderNo: true,
      stage: true,
      handedOverAt: true,
      jobDoneAt: true,
      completedAt: true,
      customer: { select: { firstName: true, lastName: true } },
      property: { select: { addressLine1: true, addressLine2: true, suburb: true, state: true, postcode: true } },
      owner: { select: { name: true } },
      opsJob: true,
    },
    orderBy: stage === 'IN_PROGRESS' ? [{ opsJob: { installDate: { sort: 'asc', nulls: 'last' } } }, { handedOverAt: 'asc' }] : stage === 'INSTALLED' ? [{ jobDoneAt: 'asc' }] : [{ completedAt: 'desc' }],
    take: stage === 'COMPLETED' ? 100 : 500,
  });
  const settings = await getOperationsSettings(ctx.db);
  const timeZone = getConfig().timeZone;
  const today = todayDateOnly(nowOf(ctx), timeZone);
  return rows.map((o) => {
    const job = o.opsJob!;
    const items = opsItems(job);
    const doneOn = o.jobDoneAt ? todayDateOnly(o.jobDoneAt, timeZone) : null;
    const rebateDue = doneOn ? addWorkingDays(doneOn, settings.rebateReminderDays) : null;
    const balanceDue = doneOn ? addWorkingDays(doneOn, settings.balanceDays) : null;
    return {
      orderId: o.id,
      orderNo: o.orderNo,
      stage: o.stage,
      customerName: fullName(o.customer),
      address: formatAddress(o.property),
      salesperson: o.owner?.name ?? null,
      acceptedAt: o.handedOverAt,
      itemsDone: items.filter((i) => i.done).length,
      itemsTotal: items.length,
      openItems: items.filter((i) => !i.done).map((i) => i.label),
      installDate: job.installDate,
      jobDoneAt: o.jobDoneAt,
      completedAt: o.completedAt,
      rebateApplied: !!job.rebateAppliedAt,
      rebateOverdue: !!rebateDue && !job.rebateAppliedAt && today >= rebateDue,
      balanceDueOn: balanceDue,
      balanceOverdue: !!balanceDue && !o.completedAt && today >= balanceDue,
      chaseAskedAt: job.balanceChaseAskedAt,
    };
  });
}

/** How many accepted jobs are being arranged, and how many are installed and waiting for the balance. */
export async function opsJobCounts(db: Db): Promise<{ inProgress: number; installed: number }> {
  const groups = await db.order.groupBy({ by: ['stage'], where: { stage: { in: ['IN_PROGRESS', 'INSTALLED'] }, sideState: 'NONE' }, _count: { _all: true } });
  const of = (stage: OrderStage) => groups.find((g) => g.stage === stage)?._count._all ?? 0;
  return { inProgress: of('IN_PROGRESS'), installed: of('INSTALLED') };
}

export interface FinalPaymentRow {
  orderId: string;
  orderNo: string;
  customerName: string;
  salesperson: string | null;
  /** The total of the proposal the customer accepted, when the CRM knows it. */
  totalCents: number | null;
  depositCents: number | null;
  /** The total less the deposit: what should still come in. Null when either is not known. */
  balanceCents: number | null;
  jobDoneAt: Date | null;
  balanceDueOn: Date | null;
  overdue: boolean;
  receivedCents: number | null;
  receivedOn: Date | null;
  completedAt: Date | null;
  note: string;
}

/**
 * Final payments, for finance: the jobs that are done and waiting for the balance (longest
 * first), or the ones whose balance has come in (latest first).
 */
export async function listFinalPayments(ctx: Ctx, which: 'DUE' | 'RECEIVED'): Promise<FinalPaymentRow[]> {
  requireAccountAccess(ctx);
  const rows = await ctx.db.order.findMany({
    where: { stage: which === 'DUE' ? 'INSTALLED' : 'COMPLETED', sideState: 'NONE', opsJob: { isNot: null } },
    select: {
      id: true,
      orderNo: true,
      jobDoneAt: true,
      completedAt: true,
      customer: { select: { firstName: true, lastName: true } },
      owner: { select: { name: true } },
      opsJob: { select: { finalAmountCents: true, finalReceivedOn: true, finalNote: true } },
      quotes: { where: { isAccepted: true }, take: 1, select: { totalCents: true } },
      deposits: { where: { status: { in: ['PENDING', 'CONFIRMED'] } }, orderBy: { submittedAt: 'desc' }, take: 1, select: { amountCents: true, receivedAmountCents: true } },
    },
    orderBy: which === 'DUE' ? [{ jobDoneAt: 'asc' }] : [{ completedAt: 'desc' }],
    take: which === 'DUE' ? 500 : 100,
  });
  const settings = await getOperationsSettings(ctx.db);
  const timeZone = getConfig().timeZone;
  const today = todayDateOnly(nowOf(ctx), timeZone);
  return rows.map((o) => {
    const total = o.quotes[0]?.totalCents ?? null;
    const deposit = o.deposits[0] ? (o.deposits[0].receivedAmountCents ?? o.deposits[0].amountCents) : null;
    const due = o.jobDoneAt ? addWorkingDays(todayDateOnly(o.jobDoneAt, timeZone), settings.balanceDays) : null;
    return {
      orderId: o.id,
      orderNo: o.orderNo,
      customerName: fullName(o.customer),
      salesperson: o.owner?.name ?? null,
      totalCents: total,
      depositCents: deposit,
      balanceCents: total !== null && deposit !== null ? Math.max(0, total - deposit) : null,
      jobDoneAt: o.jobDoneAt,
      balanceDueOn: due,
      overdue: which === 'DUE' && !!due && today >= due,
      receivedCents: o.opsJob?.finalAmountCents ?? null,
      receivedOn: o.opsJob?.finalReceivedOn ?? null,
      completedAt: o.completedAt,
      note: o.opsJob?.finalNote ?? '',
    };
  });
}

/** How many installed jobs are waiting for the balance, for finance's menu. */
export async function finalPaymentsDueCount(db: Db): Promise<number> {
  return db.order.count({ where: { stage: 'INSTALLED', sideState: 'NONE' } });
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export interface OperationsReminderResult {
  rebateReminders: number;
  balanceReminders: number;
}

/**
 * After a job is done, operations is reminded twice, each once: to apply for the rebate, and
 * that the balance has not come in by the day the customer was given. Working days are counted
 * from the day the job was done; public holidays are not known here and count as working days.
 */
export async function runOperationsReminders(base: Ctx | Db): Promise<OperationsReminderResult> {
  const ctx: Ctx = 'actor' in base ? base : systemCtx(base);
  const result: OperationsReminderResult = { rebateReminders: 0, balanceReminders: 0 };
  await withJobLock(ctx.db, 760105, async () => {
    const settings = await getOperationsSettings(ctx.db);
    const timeZone = getConfig().timeZone;
    const today = todayDateOnly(nowOf(ctx), timeZone);
    const candidates = await ctx.db.order.findMany({
      where: {
        sideState: 'NONE',
        jobDoneAt: { not: null },
        opsJob: { OR: [{ rebateAppliedAt: null, rebateRemindedAt: null }, { balanceRemindedAt: null }] },
      },
      select: { id: true },
      orderBy: { jobDoneAt: 'asc' },
      take: 500,
    });
    for (const { id } of candidates) {
      await inTx(ctx.db, async (tx) => {
        await lockOrder(tx, id);
        const order = await tx.order.findUniqueOrThrow({ where: { id }, select: { id: true, orderNo: true, stage: true, sideState: true, jobDoneAt: true, completedAt: true, opsJob: true, customer: { select: { firstName: true, lastName: true } } } });
        const job = order.opsJob;
        if (!job || !order.jobDoneAt || order.sideState !== 'NONE' || !isWithOperations(order.stage)) return;
        const passed = workingDaysBetween(todayDateOnly(order.jobDoneAt, timeZone), today);
        const now = nowOf(ctx);
        const name = `${order.customer.firstName} ${order.customer.lastName}`.trim();
        if (!job.rebateAppliedAt && !job.rebateRemindedAt && passed >= settings.rebateReminderDays) {
          await tx.opsJob.update({ where: { orderId: id }, data: { rebateRemindedAt: now } });
          await notifyRoles(tx, ctx, ['OPS'], { type: 'ops.rebate_due', title: `${order.orderNo}: apply for the rebate`, body: `The job for ${name} was done on ${formatDateOnly(todayDateOnly(order.jobDoneAt, timeZone))}.`, href: `/ops/orders/${id}`, orderId: id });
          result.rebateReminders++;
        }
        if (!order.completedAt && !job.balanceRemindedAt && passed >= settings.balanceDays) {
          await tx.opsJob.update({ where: { orderId: id }, data: { balanceRemindedAt: now } });
          await notifyRoles(tx, ctx, ['OPS'], {
            type: 'ops.balance_due',
            title: `${order.orderNo}: the balance was due`,
            body: `${name} was asked to pay within ${settings.balanceDays} working days. Check the account. If the money is not there, ask sales to chase it.`,
            href: `/ops/orders/${id}`,
            orderId: id,
          });
          result.balanceReminders++;
        }
      });
    }
    return true;
  });
  return result;
}
