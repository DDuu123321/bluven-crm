// The steps a salesperson takes with a job before the proposal goes out: opening it, saying
// where the customer came from, and saying whether the customer is ready for a design.
import { inTx, nowOf, type Ctx } from '../context';
import { ConflictError, FieldErrors, ValidationError } from '../errors';
import { addActivity } from './activity';
import { audit } from './audit';
import { lockOrderForEdit, lockOrderForStaff, lockOrderForWork, syncOrderStage, touchStaffActivity } from './orders';

export interface LeadOriginInput {
  /** One of the lead sources the managers keep. */
  leadOriginId: string;
  /** Who exactly, when the list does not say: the name of the person who referred them, for example. */
  note?: string;
}

async function requireOrigin(tx: Parameters<Parameters<typeof inTx>[1]>[0], input: LeadOriginInput): Promise<{ id: string; label: string; note: string }> {
  const errors = new FieldErrors();
  const note = (input.note ?? '').trim();
  if (note.length > 200) errors.add('leadOriginNote', 'Use at most 200 characters.');
  const origin = input.leadOriginId ? await tx.leadOrigin.findUnique({ where: { id: input.leadOriginId } }) : null;
  if (!origin || !origin.isActive) errors.add('leadOriginId', 'Choose where this customer came from.');
  errors.throwIfAny();
  return { id: origin!.id, label: origin!.label, note };
}

/**
 * The salesperson takes the job up. From here on it is theirs to work on and counts as their
 * job, and where the customer came from is on record, which is what partners are paid by.
 * Only the order's salesperson or a manager can open it, and only once.
 */
export async function openJob(ctx: Ctx, input: { orderId: string } & LeadOriginInput): Promise<void> {
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    if (order.sideState === 'LOST' || order.sideState === 'CANCELLED') throw new ConflictError(`This order is ${order.sideState === 'LOST' ? 'marked as lost' : 'cancelled'}.`);
    if (order.openedAt) throw new ConflictError('This job is already open.');
    if (!order.ownerId) throw new ConflictError('Assign this lead to a salesperson first. The job is opened by whoever it belongs to.');
    const origin = await requireOrigin(tx, input);
    const now = nowOf(ctx);
    await tx.order.update({
      where: { id: order.id },
      data: { openedAt: now, openedById: ctx.actor.kind === 'user' ? ctx.actor.id : null, leadOriginId: origin.id, leadOriginNote: origin.note },
    });
    const source = `${origin.label}${origin.note ? ` (${origin.note})` : ''}`;
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'ASSIGNMENT', summary: 'Job opened', body: `Lead source: ${source}`, payload: { leadOriginId: origin.id } });
    await touchStaffActivity(tx, ctx, order);
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'order.open',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: job opened, lead source ${source}`,
      after: { openedAt: now, leadOriginId: origin.id, leadOriginNote: origin.note },
    });
  });
}

/** Corrects where the customer came from, or fills it in on an order from before it was asked for. */
export async function setLeadOrigin(ctx: Ctx, input: { orderId: string } & LeadOriginInput): Promise<void> {
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, input.orderId);
    if (!order.openedAt) throw new ConflictError('The lead source is recorded when the job is opened.');
    const origin = await requireOrigin(tx, input);
    const before = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { leadOriginId: true, leadOriginNote: true } });
    if (before.leadOriginId === origin.id && before.leadOriginNote === origin.note) return;
    await tx.order.update({ where: { id: order.id }, data: { leadOriginId: origin.id, leadOriginNote: origin.note } });
    const source = `${origin.label}${origin.note ? ` (${origin.note})` : ''}`;
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'SYSTEM', summary: `Lead source set to ${source}`, payload: { leadOriginId: origin.id } });
    await audit(tx, ctx, {
      action: 'order.lead_origin',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: lead source set to ${source}`,
      before,
      after: { leadOriginId: origin.id, leadOriginNote: origin.note },
    });
  });
}

export const INTENTS = ['DESIGN', 'FOLLOW_UP'] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * Where the salesperson sees the customer: ready for a design, or still to be followed up. It
 * can be said either way for as long as no proposal has gone out; after that the order's stage
 * follows from what happened. A customer who will not buy is not a third answer here: that
 * order is marked as lost.
 */
export async function setIntent(ctx: Ctx, input: { orderId: string; intent: string }): Promise<void> {
  const intent = (INTENTS as readonly string[]).includes(input.intent) ? (input.intent as Intent) : null;
  if (!intent) throw new ValidationError('Choose how the customer stands.', { intent: 'Choose one.' });
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForWork(tx, ctx, input.orderId);
    if (order.sideState === 'ON_HOLD') throw new ConflictError('Take the order off hold first.');
    if (order.stage !== 'FOLLOW_UP' && order.stage !== 'DESIGN') throw new ConflictError('This can only be changed before a proposal has gone out.');
    if ((intent === 'DESIGN') === (order.stage === 'DESIGN')) return;
    await tx.order.update({ where: { id: order.id }, data: { designAt: intent === 'DESIGN' ? nowOf(ctx) : null } });
    const summary = intent === 'DESIGN' ? 'The customer wants a proposal: design started' : 'Back to following up';
    await touchStaffActivity(tx, ctx, order);
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'order.intent',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
      after: { intent },
    });
  });
}
