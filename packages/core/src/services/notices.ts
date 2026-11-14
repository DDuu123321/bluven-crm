// The e-mails the CRM sends to a customer by itself: the welcome when operations accepts the
// order, the dates of the installation, and the thank-you that asks for the balance. Here they
// are written out and queued; the background process sends them through the operations mailbox.
import type { DbOrTx, Prisma, Tx } from '@bluven/db';
import { actorId, inTx, nowOf, type Ctx } from '../context';
import {
  DELIVERY_MODE_LABEL,
  NOTICE_FIELDS,
  NOTICE_KINDS,
  NOTICE_KIND_LABEL,
  can,
  fillTemplate,
  formatAddress,
  formatDateOnly,
  fullName,
  unfilledTemplateFields,
  unknownTemplateFields,
  type NoticeField,
  type NoticeKind,
} from '../domain';
import { ConflictError, FieldErrors, ForbiddenError, NotFoundError } from '../errors';
import { newId } from '../ids';
import { audit } from './audit';

export interface NoticeText {
  /** Off: nothing of this kind is sent. */
  enabled: boolean;
  subject: string;
  body: string;
}

export interface OperationsSettings {
  /** Working days after the job is done before operations is reminded to apply for the rebate. */
  rebateReminderDays: number;
  /** Working days the customer is given to pay the balance. After them operations is reminded that it is still open. */
  balanceDays: number;
  /** The user whose connected mailbox sends these e-mails. Null: the mailbox of whoever does the step. */
  mailboxUserId: string | null;
  notices: Record<NoticeKind, NoticeText>;
}

export const DEFAULT_OPERATIONS_SETTINGS: OperationsSettings = {
  rebateReminderDays: 2,
  balanceDays: 5,
  mailboxUserId: null,
  notices: {
    WELCOME: {
      enabled: true,
      subject: 'Welcome to Bluven: your order {{order_no}}',
      body: `Hi {{first_name}},

Thank you for choosing Bluven. We have received your deposit, and your order {{order_no}} for {{address}} is now with our operations team.

What happens next:

- Where your installation needs it, we apply to the network for approval to connect your system.
- We get your equipment ready and book your installer.
- We write to you again as soon as the date of your installation is set.

If you have any questions in the meantime, just reply to this e-mail.

Regards,
Bluven Operations`,
    },
    SCHEDULE: {
      enabled: true,
      subject: 'Your Bluven installation is booked for {{install_date}}',
      body: `Hi {{first_name}},

Your installation at {{address}} is booked for {{install_date}}.

{{delivery}}

The work will be carried out by {{installer}}. Please make sure that someone is home on the day, and that the meter box and the place where the system goes can be reached.

If the date does not suit you, reply to this e-mail as soon as you can and we will find another one.

Regards,
Bluven Operations`,
    },
    JOB_DONE: {
      enabled: true,
      subject: 'Your Bluven installation is complete',
      body: `Hi {{first_name}},

Your installation at {{address}} is complete. Thank you for choosing Bluven. We hope you enjoy your new system.

If you are happy with the work, please pay the remaining balance within {{balance_days}} working days, using the details on your invoice. If anything is not right, reply to this e-mail and we will look into it straight away.

Regards,
Bluven Operations`,
    },
  },
};

const KEY = 'operations';

function sanitize(value: unknown): OperationsSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof OperationsSettings, unknown>>;
  const days = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 60 ? n : fallback);
  const stored = (typeof v.notices === 'object' && v.notices !== null ? v.notices : {}) as Partial<Record<NoticeKind, Partial<NoticeText>>>;
  const notices = {} as Record<NoticeKind, NoticeText>;
  for (const kind of NOTICE_KINDS) {
    const d = DEFAULT_OPERATIONS_SETTINGS.notices[kind];
    const s = stored[kind] ?? {};
    notices[kind] = {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
      subject: typeof s.subject === 'string' && s.subject.trim() ? s.subject : d.subject,
      body: typeof s.body === 'string' && s.body.trim() ? s.body : d.body,
    };
  }
  return {
    rebateReminderDays: days(v.rebateReminderDays, DEFAULT_OPERATIONS_SETTINGS.rebateReminderDays),
    balanceDays: days(v.balanceDays, DEFAULT_OPERATIONS_SETTINGS.balanceDays),
    mailboxUserId: typeof v.mailboxUserId === 'string' && v.mailboxUserId ? v.mailboxUserId : null,
    notices,
  };
}

export async function getOperationsSettings(db: DbOrTx): Promise<OperationsSettings> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return sanitize(row?.value);
}

export async function updateOperationsSettings(ctx: Ctx, next: OperationsSettings): Promise<OperationsSettings> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'admin.settings')) throw new ForbiddenError();
  const errors = new FieldErrors();
  const days = (n: number) => Number.isInteger(n) && n >= 1 && n <= 60;
  if (!days(next.rebateReminderDays)) errors.add('rebateReminderDays', 'Enter a whole number of working days between 1 and 60.');
  if (!days(next.balanceDays)) errors.add('balanceDays', 'Enter a whole number of working days between 1 and 60.');
  for (const kind of NOTICE_KINDS) {
    const text = next.notices[kind];
    const subject = text.subject.trim();
    const body = text.body.replace(/\r\n?/g, '\n').trim();
    if (!subject) errors.add(`${kind}.subject`, 'Enter a subject.');
    else if (subject.length > 200) errors.add(`${kind}.subject`, 'Use at most 200 characters.');
    if (!body) errors.add(`${kind}.body`, 'Enter the text.');
    else if (body.length > 10_000) errors.add(`${kind}.body`, 'Use at most 10,000 characters.');
    const unknownInSubject = unknownTemplateFields(subject, NOTICE_FIELDS);
    const unknownInBody = unknownTemplateFields(body, NOTICE_FIELDS);
    // A field nobody fills in would reach the customer in its braces.
    if (unknownInSubject.length > 0) errors.add(`${kind}.subject`, `“{{${unknownInSubject[0]}}}” is not one of the fields. See the list below the texts.`);
    if (unknownInBody.length > 0) errors.add(`${kind}.body`, `“{{${unknownInBody[0]}}}” is not one of the fields. See the list below the texts.`);
  }
  if (next.mailboxUserId) {
    const mailbox = await ctx.db.emailAccount.findUnique({ where: { userId: next.mailboxUserId }, select: { id: true } });
    if (!mailbox) errors.add('mailboxUserId', 'This person has not connected a mailbox.');
  }
  errors.throwIfAny();

  return inTx(ctx.db, async (tx) => {
    const before = await getOperationsSettings(tx);
    const saved = sanitize({
      ...next,
      notices: Object.fromEntries(NOTICE_KINDS.map((kind) => [kind, { enabled: next.notices[kind].enabled, subject: next.notices[kind].subject.trim(), body: next.notices[kind].body.replace(/\r\n?/g, '\n').trim() }])),
    });
    const value = saved as unknown as Prisma.InputJsonValue;
    await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value, updatedById: actorId(ctx) }, update: { value, updatedById: actorId(ctx) } });
    await audit(tx, ctx, { action: 'settings.update', entityType: 'Setting', entityId: KEY, summary: 'Updated the settings for operations and the e-mails to customers', before, after: saved });
    return saved;
  });
}

/**
 * The address an automatic e-mail goes to: the customer's main one, as long as somebody has
 * confirmed that it is theirs. An address that only came with a website enquiry is not written
 * to: anybody can type any address into that form. `waiting` is such an address, when there is one.
 */
async function recipientOf(tx: Tx, customerId: string): Promise<{ to: string | null; waiting: string | null }> {
  const emails = await tx.customerEmail.findMany({ where: { customerId }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { email: true, unconfirmed: true } });
  return { to: emails.find((e) => !e.unconfirmed)?.email ?? null, waiting: emails.find((e) => e.unconfirmed)?.email ?? null };
}

export type QueueOutcome = 'queued' | 'off' | 'no_address' | 'incomplete';

/**
 * Writes one of the automatic e-mails for an order and queues it, inside the caller's
 * transaction. The text is fixed at this moment, so that what the customer receives is what
 * was true when the step was taken. Nothing is queued when that kind of e-mail is switched off.
 * When it cannot be sent at all (no address, something the text needs is not on record), a row
 * says so, for operations to see on the order.
 */
export async function queueNotice(tx: Tx, ctx: Ctx, orderId: string, kind: NoticeKind): Promise<QueueOutcome> {
  const settings = await getOperationsSettings(tx);
  const text = settings.notices[kind];
  if (!text.enabled) return 'off';
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, orderNo: true, customerId: true, customer: { select: { firstName: true, lastName: true } }, property: true, owner: { select: { name: true } }, opsJob: true },
  });
  const job = order.opsJob;
  const delivery =
    job?.deliveryMode === 'PICKUP'
      ? 'Your installer brings the equipment on the day.'
      : job?.deliveryMode === 'DELIVERY' && job.deliveryEta
        ? `Your equipment is expected to arrive on ${formatDateOnly(job.deliveryEta)}.`
        : '';
  const values: Partial<Record<NoticeField, string>> = {
    first_name: order.customer.firstName,
    full_name: fullName(order.customer),
    address: formatAddress(order.property),
    order_no: order.orderNo,
    salesperson: order.owner?.name ?? 'your Bluven salesperson',
    install_date: job?.installDate ? formatDateOnly(job.installDate) : '',
    delivery,
    installer: job?.installerName.trim() || 'one of our accredited installers',
    balance_days: String(settings.balanceDays),
  };
  const subject = fillTemplate(text.subject, values).slice(0, 250);
  const body = fillTemplate(text.body, values);
  const { to, waiting } = await recipientOf(tx, order.customerId);
  const missing = unfilledTemplateFields(`${subject}\n${body}`, NOTICE_FIELDS);
  const note = !to
    ? waiting
      ? `Nobody has confirmed that ${waiting} is the customer’s address: it came with the website enquiry. Confirm it on the order, then send this again.`
      : 'The customer has no e-mail address on record. Add one to the customer, then send this again.'
    : missing.length > 0
      ? `The text needs something that is not on record yet: ${missing.map((f) => NOTICE_FIELDS[f as NoticeField].replace(/ \(.*\)$/, '').toLowerCase()).join(', ')}.`
      : '';
  const now = nowOf(ctx);
  await tx.customerNotice.create({
    data: {
      id: newId('ntc'),
      orderId: order.id,
      kind,
      status: note ? 'SKIPPED' : 'PENDING',
      toAddress: to ?? '',
      subject,
      body,
      payload: (kind === 'SCHEDULE' ? { installDate: job?.installDate?.toISOString().slice(0, 10) ?? null, deliveryMode: job?.deliveryMode ?? null, deliveryEta: job?.deliveryEta?.toISOString().slice(0, 10) ?? null } : {}) as Prisma.InputJsonValue,
      nextAttemptAt: note ? null : now,
      note,
      createdById: actorId(ctx),
      createdAt: now,
    },
  });
  return !to ? 'no_address' : missing.length > 0 ? 'incomplete' : 'queued';
}

export interface NoticeView {
  id: string;
  kind: NoticeKind;
  kindLabel: string;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  toAddress: string;
  subject: string;
  body: string;
  note: string;
  createdAt: Date;
  sentAt: Date | null;
  /** For the dates e-mail: what it announced. */
  payload: { installDate?: string | null; deliveryMode?: string | null; deliveryEta?: string | null };
}

/** The automatic e-mails of an order, newest first. */
export async function listNotices(db: DbOrTx, orderId: string): Promise<NoticeView[]> {
  const rows = await db.customerNotice.findMany({ where: { orderId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as NoticeKind,
    kindLabel: NOTICE_KIND_LABEL[r.kind as NoticeKind] ?? r.kind,
    status: r.status as NoticeView['status'],
    toAddress: r.toAddress,
    subject: r.subject,
    body: r.body,
    note: r.note,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    payload: (typeof r.payload === 'object' && r.payload !== null ? r.payload : {}) as NoticeView['payload'],
  }));
}

/**
 * Puts an e-mail that did not go out back in the queue, as it was written. For operations, after
 * whatever stopped it has been put right: a mailbox connected, an address added to the customer.
 */
export async function retryNotice(ctx: Ctx, input: { noticeId: string }): Promise<void> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'ops.handoffs')) throw new ForbiddenError('Only operations can send these e-mails.');
  await inTx(ctx.db, async (tx) => {
    const notice = await tx.customerNotice.findUnique({ where: { id: input.noticeId }, include: { order: { select: { orderNo: true, customerId: true, sideState: true } } } });
    if (!notice) throw new NotFoundError('E-mail not found.');
    if (notice.status !== 'FAILED' && notice.status !== 'SKIPPED') throw new ConflictError(notice.status === 'SENT' ? 'This e-mail has already been sent.' : 'This e-mail is already waiting to be sent.');
    if (notice.order.sideState === 'CANCELLED') throw new ConflictError('This order has been cancelled.');
    const to = notice.toAddress || (await recipientOf(tx, notice.order.customerId)).to;
    if (!to) throw new ConflictError('The customer still has no confirmed e-mail address on record.');
    if (unfilledTemplateFields(`${notice.subject}\n${notice.body}`, NOTICE_FIELDS).length > 0) throw new ConflictError('This text was written while something it needs was missing. Send the e-mail afresh instead.');
    await tx.customerNotice.update({ where: { id: notice.id }, data: { status: 'PENDING', toAddress: to, attempts: 0, nextAttemptAt: nowOf(ctx), note: '' } });
    await audit(tx, ctx, { action: 'notice.retry', entityType: 'CustomerNotice', entityId: notice.id, orderId: notice.orderId, customerId: notice.order.customerId, summary: `${notice.order.orderNo}: queued the ${NOTICE_KIND_LABEL[notice.kind as NoticeKind]?.toLowerCase() ?? notice.kind} e-mail again` });
  });
}

/** What the dates e-mail would say about the equipment, for showing before it is sent. */
export function describeDelivery(job: { deliveryMode: string | null; deliveryEta: Date | null }): string {
  if (job.deliveryMode === 'PICKUP') return DELIVERY_MODE_LABEL.PICKUP;
  if (job.deliveryMode === 'DELIVERY') return job.deliveryEta ? `Delivered to the site, expected ${formatDateOnly(job.deliveryEta)}` : 'Delivered to the site, day not known yet';
  return 'Not arranged yet';
}
