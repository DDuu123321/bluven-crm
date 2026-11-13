// E-mail on an order: writing to the customer, reading what was exchanged, and turning what the
// customer sent into documents of the order.
import type { Db, EmailAccount, Prisma } from '@bluven/db';
import {
  ConflictError,
  FieldErrors,
  ForbiddenError,
  INLINE_SAFE_TYPES,
  NotFoundError,
  ValidationError,
  actorId,
  addActivity,
  archiveContract,
  audit,
  editBlockReason,
  fullName,
  getStorage,
  inTx,
  isManager,
  isOrderStaff,
  loadOrderState,
  lockOrderForStaff,
  markQuoteSentInTx,
  newId,
  normalizeEmailAddress,
  nowOf,
  replySubject,
  requireOrderView,
  requireUser,
  stageUpload,
  syncOrderStage,
  textToHtml,
  touchStaffActivity,
  uploadDocument,
  type Ctx,
} from '@bluven/core';
import { MailApiError, type MailApi, type UploadedAttachment } from '../zoho/client';
import { mailApiFor, type MailDeps } from './accounts';

/** What one message may carry in attachments. Mail systems refuse much more than this. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_RECIPIENTS = 10;

export interface SendEmailInput {
  orderId: string;
  to: string[];
  cc?: string[];
  subject: string;
  /** Plain text, as typed. */
  body: string;
  /** Documents of the order to attach. */
  documentIds?: string[];
  /** The message this one answers. */
  replyToEmailId?: string | null;
}

function recipients(raw: string[], field: string, errors: FieldErrors): string[] {
  const out: string[] = [];
  for (const entry of raw.flatMap((r) => r.split(/[,;\s]+/)).filter(Boolean)) {
    const address = normalizeEmailAddress(entry);
    if (!address || address !== entry.trim().toLowerCase().replace(/^<|>$/g, '')) errors.add(field, `“${entry}” is not an e-mail address.`);
    else if (!out.includes(address)) out.push(address);
  }
  if (out.length > MAX_RECIPIENTS) errors.add(field, `Use at most ${MAX_RECIPIENTS} addresses.`);
  return out;
}

/**
 * Sends an e-mail to the customer from the salesperson's own mailbox, so it sits in their sent
 * folder like any other, and records it on the order. Attaching the file of a quote version
 * records that version as sent.
 */
export async function sendOrderEmail(ctx: Ctx, input: SendEmailInput, deps: MailDeps = {}): Promise<{ id: string | null }> {
  const actor = requireUser(ctx);
  const db = ctx.db;
  const { order } = await requireOrderView(db, ctx, input.orderId);
  if (!isOrderStaff(actor, order)) throw new ForbiddenError('Only the salesperson for this order or a manager can write to the customer.');

  const errors = new FieldErrors();
  const to = recipients(input.to, 'to', errors);
  const cc = recipients(input.cc ?? [], 'cc', errors).filter((a) => !to.includes(a));
  const subject = input.subject.replace(/[\r\n]+/g, ' ').trim();
  const body = input.body.replace(/\r\n?/g, '\n').trim();
  if (to.length === 0 && !errors.has('to')) errors.add('to', 'Enter who the message goes to.');
  if (!subject) errors.add('subject', 'Give the message a subject.');
  if (subject.length > 300) errors.add('subject', 'Use at most 300 characters.');
  if (!body) errors.add('body', 'Write the message.');
  if (body.length > 50_000) errors.add('body', 'Use at most 50,000 characters.');

  // A message from an order goes to that order's customer. Others may be copied in, but an
  // address typed wrongly must not send one customer's quote to a stranger unnoticed.
  // An address that only came with a website enquiry does not count until someone has confirmed it:
  // anybody can fill in that form with another person's phone number and their own address.
  const addresses = await db.customerEmail.findMany({ where: { customerId: order.customerId }, select: { email: true, unconfirmed: true } });
  const onRecord = new Set(addresses.filter((e) => !e.unconfirmed).map((e) => e.email));
  if (to.length > 0 && !to.some((a) => onRecord.has(a))) {
    const waiting = addresses.find((e) => e.unconfirmed && to.includes(e.email));
    errors.add(
      'to',
      waiting
        ? `${waiting.email} came with a website enquiry and nobody has confirmed that it is the customer’s. Confirm it on the customer first, or write to an address that is confirmed.`
        : 'At least one recipient must be an address on this customer’s record. Add the address to the customer first.',
    );
  }

  const ids = [...new Set(input.documentIds ?? [])];
  const documents = ids.length ? await db.document.findMany({ where: { id: { in: ids }, orderId: order.id, deletedAt: null } }) : [];
  if (documents.length !== ids.length) errors.add('documentIds', 'One of the chosen files is no longer in this order.');
  if (documents.reduce((sum, d) => sum + d.sizeBytes, 0) > MAX_ATTACHMENT_BYTES) errors.add('documentIds', `The attachments are larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB together. Send fewer or smaller files.`);
  errors.throwIfAny();

  const mailbox = await db.emailAccount.findUnique({ where: { userId: actor.id } });
  if (!mailbox) throw new ValidationError('Connect your mailbox first, under your account, so the message can be sent from your own address.');
  if (mailbox.needsReconnect) throw new ValidationError('Your mailbox has to be connected again before you can send. You can do that under your account.');

  let replyTo: { id: string; providerMessageId: string | null; providerThreadId: string | null; accountId: string | null; messageIdHeader: string | null } | null = null;
  if (input.replyToEmailId) {
    replyTo = await db.emailMessage.findFirst({ where: { id: input.replyToEmailId, customerId: order.customerId }, select: { id: true, providerMessageId: true, providerThreadId: true, accountId: true, messageIdHeader: true } });
    if (!replyTo) throw new NotFoundError('The message you are answering was not found.');
  }

  const api = deps.apiFor ? deps.apiFor(mailbox) : mailApiFor(db, mailbox, deps);
  const html = textToHtml(body);
  let sent: { messageId: string | null; messageIdHeader?: string | null };
  try {
    const attachments: UploadedAttachment[] = [];
    for (const doc of documents) attachments.push(await api.uploadAttachment(mailbox.providerAccountId, doc.fileName, getStorage().createReadStream(doc.storageKey)));
    // Answering in the mailbox the original is in lets the provider thread it properly.
    const replyToMessageId = replyTo && replyTo.accountId === mailbox.id ? replyTo.providerMessageId : null;
    sent = await api.send(mailbox.providerAccountId, { from: mailbox.address, to, cc, subject, html, attachments, replyToMessageId });
  } catch (e) {
    if (!(e instanceof MailApiError)) throw e;
    if (e.authFailed) {
      await db.emailAccount.update({ where: { id: mailbox.id }, data: { needsReconnect: true, lastError: e.message.slice(0, 500) } });
      throw new ValidationError('Zoho no longer accepts the CRM’s access to your mailbox. Connect it again under your account, then send the message.');
    }
    throw new ValidationError(`The message was not sent: ${e.retryable ? 'the mail service could not be reached. Try again in a moment.' : e.message}`);
  }

  // From here on the customer has the message. If recording fails, the next read of the sent
  // folder puts it on the timeline anyway.
  try {
    const id = await inTx(db, async (tx) => {
      const locked = await lockOrderForStaff(tx, ctx, order.id);
      const now = nowOf(ctx);
      const emailId = newId('eml');
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: locked.customerId }, select: { firstName: true, lastName: true } });
      // The provider's conversation: the one being answered, when it is in this mailbox; otherwise this
      // message starts one, and the provider gives a conversation the id of its first message.
      const answeredHere = replyTo && replyTo.accountId === mailbox.id ? (replyTo.providerThreadId ?? replyTo.providerMessageId) : null;
      // Its Message-ID lets the customer's answer, and the copy in the sent folder, be matched to it.
      const header = sent.messageIdHeader && !(await tx.emailMessage.findUnique({ where: { messageIdHeader: sent.messageIdHeader }, select: { id: true } })) ? sent.messageIdHeader : null;
      const activityId = await addActivity(tx, ctx, {
        customerId: locked.customerId,
        orderId: locked.id,
        type: 'EMAIL_OUT',
        summary: `Email to ${fullName(customer)}: ${subject}`,
        body: body.slice(0, 4000),
        occurredAt: now,
        payload: { emailId, attachments: documents.length },
      });
      await tx.emailMessage.create({
        data: {
          id: emailId,
          accountId: mailbox.id,
          customerId: locked.customerId,
          orderId: locked.id,
          direction: 'OUT',
          providerMessageId: sent.messageId,
          providerThreadId: answeredHere ?? sent.messageId,
          messageIdHeader: header,
          inReplyTo: replyTo?.messageIdHeader ?? null,
          fromAddress: mailbox.address,
          fromName: actor.name,
          toAddresses: to,
          ccAddresses: cc,
          subject,
          bodyText: body,
          bodyHtml: html,
          sentAt: now,
          sentById: actor.id,
          activityId,
          createdAt: now,
        },
      });
      for (const doc of documents) {
        await tx.emailAttachment.create({ data: { id: newId('ema'), messageId: emailId, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, documentId: doc.id, createdAt: now } });
      }
      if (!locked.firstContactedAt) await tx.order.update({ where: { id: locked.id }, data: { firstContactedAt: now } });
      // Sending the file of a quote version is sending that version.
      if (documents.length && !editBlockReason(locked)) {
        const quotes = await tx.quote.findMany({ where: { orderId: locked.id, documentId: { in: documents.map((d) => d.id) }, sentAt: null }, select: { id: true } });
        for (const quote of quotes) await markQuoteSentInTx(tx, ctx, locked, quote.id, { sentAt: now, via: 'EMAIL' });
      }
      await touchStaffActivity(tx, ctx, locked);
      await syncOrderStage(tx, ctx, locked.id);
      await audit(tx, ctx, {
        action: 'mail.send',
        entityType: 'EmailMessage',
        entityId: emailId,
        orderId: locked.id,
        customerId: locked.customerId,
        summary: `${locked.orderNo}: sent an e-mail to ${to.join(', ')}`,
        after: { from: mailbox.address, to, cc, subject, attachments: documents.map((d) => d.fileName), inReplyTo: replyTo?.id ?? null },
      });
      return emailId;
    });
    return { id };
  } catch (e) {
    console.error('[mail] the message was sent but could not be recorded', e);
    return { id: null };
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface EmailAttachmentView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Whether the CRM holds the file (received attachments that were fetched). */
  available: boolean;
  skippedReason: string | null;
  /** The order document it was filed as, or was sent from. */
  documentId: string | null;
  documentLabel: string | null;
  /**
   * What the assistant took a received file for: the key of a document type, "none" for a file
   * that belongs in no folder, or null when it has not looked or could not tell.
   */
  suggestedKind: string | null;
  suggestedConfidence: string | null;
  /** One line on what the file shows. */
  suggestedNote: string | null;
}

export interface EmailView {
  id: string;
  direction: 'IN' | 'OUT';
  subject: string;
  fromName: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  sentAt: Date;
  bodyText: string;
  hasHtml: boolean;
  orderId: string | null;
  /** The salesperson who wrote it in the CRM, when that is how it was sent. */
  sentByName: string | null;
  /** A sender whose address is not, or not confirmed to be, the customer's. */
  unknownSender: string | null;
  /** That address is on the customer's record, waiting for someone to confirm it. */
  senderAwaitsConfirmation: boolean;
  attachments: EmailAttachmentView[];
}

const emailInclude = { sentBy: { select: { name: true } }, attachments: { orderBy: { createdAt: 'asc' }, include: { document: { select: { deletedAt: true, type: { select: { label: true } } } } } } } satisfies Prisma.EmailMessageInclude;
type EmailRow = Prisma.EmailMessageGetPayload<{ include: typeof emailInclude }>;

const toView = (m: EmailRow, unconfirmed: ReadonlySet<string> = new Set()): EmailView => ({
  id: m.id,
  direction: m.direction,
  subject: m.subject,
  fromName: m.fromName,
  fromAddress: m.fromAddress,
  to: m.toAddresses,
  cc: m.ccAddresses,
  sentAt: m.sentAt,
  bodyText: m.bodyText,
  hasHtml: !!m.bodyHtml,
  orderId: m.orderId,
  sentByName: m.sentBy?.name ?? null,
  unknownSender: m.unknownSender,
  senderAwaitsConfirmation: !!m.unknownSender && unconfirmed.has(m.unknownSender),
  attachments: m.attachments.map((a) => ({
    id: a.id,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    available: !!a.storageKey,
    skippedReason: a.skippedReason,
    documentId: a.document && !a.document.deletedAt ? a.documentId : null,
    documentLabel: a.document && !a.document.deletedAt ? a.document.type.label : null,
    suggestedKind: a.aiKind,
    suggestedConfidence: a.aiConfidence,
    suggestedNote: a.aiNote,
  })),
});

/** Whether the actor may read this customer's correspondence that is not tied to an order. */
async function canSeeCustomerMail(ctx: Ctx, customerId: string): Promise<boolean> {
  if (ctx.actor.kind !== 'user') return true;
  if (isManager(ctx.actor)) return true;
  return !!(await ctx.db.order.findFirst({ where: { customerId, ownerId: ctx.actor.id }, select: { id: true } }));
}

/**
 * E-mail is correspondence about the sale: sales and managers read it, and operations once the
 * order has been pushed to them. Finance sees the deposit, not the letters.
 */
async function requireMailView(ctx: Ctx, orderId: string): Promise<{ staff: boolean; customerId: string }> {
  const { order, view } = await requireOrderView(ctx.db, ctx, orderId);
  if (view !== 'FULL' && view !== 'OPS') throw new NotFoundError('Order not found.');
  return { staff: ctx.actor.kind !== 'user' || isOrderStaff(ctx.actor, order), customerId: order.customerId };
}

export interface OrderMail {
  /** Newest first. */
  emails: EmailView[];
  /** Mail with this customer that is not on any order yet, for staff to place. */
  unplaced: EmailView[];
}

export async function getOrderMail(ctx: Ctx, orderId: string): Promise<OrderMail> {
  const { staff, customerId } = await requireMailView(ctx, orderId);
  const [emails, unplaced, waiting] = await Promise.all([
    ctx.db.emailMessage.findMany({ where: { orderId }, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], include: emailInclude, take: 200 }),
    staff ? ctx.db.emailMessage.findMany({ where: { customerId, orderId: null }, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], include: emailInclude, take: 50 }) : Promise.resolve([]),
    ctx.db.customerEmail.findMany({ where: { customerId, unconfirmed: true }, select: { email: true } }),
  ]);
  const unconfirmed = new Set(waiting.map((e) => e.email));
  return { emails: emails.map((m) => toView(m, unconfirmed)), unplaced: unplaced.map((m) => toView(m, unconfirmed)) };
}

async function loadVisibleEmail(ctx: Ctx, emailId: string): Promise<EmailRow & { bodyHtml: string | null }> {
  const email = await ctx.db.emailMessage.findUnique({ where: { id: emailId }, include: emailInclude });
  if (!email) throw new NotFoundError('E-mail not found.');
  if (email.orderId) {
    await requireMailView(ctx, email.orderId).catch(() => {
      throw new NotFoundError('E-mail not found.');
    });
  } else if (!(await canSeeCustomerMail(ctx, email.customerId))) throw new NotFoundError('E-mail not found.');
  return email;
}

/** The message as it was received, for display inside a sandbox. Never put this into a page as it is. */
export async function openEmailHtml(ctx: Ctx, emailId: string): Promise<{ subject: string; html: string }> {
  const email = await loadVisibleEmail(ctx, emailId);
  if (!email.bodyHtml) throw new NotFoundError('E-mail not found.');
  return { subject: email.subject, html: email.bodyHtml };
}

export interface OpenedAttachment {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  inlineSafe: boolean;
}

/** Access to a received attachment, checked and logged like access to any document. */
export async function openEmailAttachment(ctx: Ctx, input: { attachmentId: string; purpose: 'download' | 'head' }): Promise<OpenedAttachment> {
  const attachment = await ctx.db.emailAttachment.findUnique({ where: { id: input.attachmentId }, include: { message: { select: { id: true, orderId: true, customerId: true, subject: true } } } });
  if (!attachment || !attachment.storageKey) throw new NotFoundError('Attachment not found.');
  await loadVisibleEmail(ctx, attachment.message.id).catch(() => {
    throw new NotFoundError('Attachment not found.');
  });
  if (input.purpose === 'download') {
    const recent = await ctx.db.auditLog.findFirst({ where: { entityType: 'EmailAttachment', entityId: attachment.id, action: 'mail.attachment_download', actorId: actorId(ctx), at: { gte: new Date(nowOf(ctx).getTime() - 5 * 60_000) } }, select: { id: true } });
    if (!recent) {
      await audit(ctx.db, ctx, {
        action: 'mail.attachment_download',
        entityType: 'EmailAttachment',
        entityId: attachment.id,
        orderId: attachment.message.orderId,
        customerId: attachment.message.customerId,
        summary: `Opened the e-mail attachment “${attachment.fileName}”`,
      });
    }
  }
  return { fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, storageKey: attachment.storageKey, inlineSafe: INLINE_SAFE_TYPES.has(attachment.mimeType) };
}

// ---------------------------------------------------------------------------
// Placing mail and using what came with it
// ---------------------------------------------------------------------------

/** Puts a message that is on no order (the customer has several open ones) onto this order, with the rest of its conversation. */
export async function assignEmailToOrder(ctx: Ctx, input: { emailId: string; orderId: string }): Promise<void> {
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    const email = await tx.emailMessage.findUnique({ where: { id: input.emailId } });
    if (!email || email.customerId !== order.customerId) throw new NotFoundError('E-mail not found.');
    if (email.orderId === order.id) return;
    if (email.orderId) throw new ConflictError('This message is already on another order.');
    const thread = email.providerThreadId ? await tx.emailMessage.findMany({ where: { customerId: order.customerId, orderId: null, accountId: email.accountId, providerThreadId: email.providerThreadId } }) : [email];
    const moved = thread.some((m) => m.id === email.id) ? thread : [...thread, email];
    await tx.emailMessage.updateMany({ where: { id: { in: moved.map((m) => m.id) } }, data: { orderId: order.id } });
    const activityIds = moved.map((m) => m.activityId).filter((id): id is string => !!id);
    await tx.activity.updateMany({ where: { id: { in: activityIds } }, data: { orderId: order.id } });
    // A summary written between the arrival of this mail and now does not know about it. The
    // entries keep the time they arrived, so the summary's own mark is moved back before them.
    const earliest = await tx.activity.findFirst({ where: { id: { in: activityIds } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    if (earliest) await tx.orderSummary.updateMany({ where: { orderId: order.id, coversUntil: { gte: earliest.createdAt } }, data: { coversUntil: new Date(earliest.createdAt.getTime() - 1) } });
    const { leadCreatedAt } = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { leadCreatedAt: true } });
    const firstSent = moved.filter((m) => m.direction === 'OUT' && m.sentAt >= leadCreatedAt).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())[0];
    if (firstSent && !order.firstContactedAt) await tx.order.update({ where: { id: order.id }, data: { firstContactedAt: firstSent.sentAt } });
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'mail.assign',
      entityType: 'EmailMessage',
      entityId: email.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: placed ${moved.length === 1 ? 'an e-mail' : `${moved.length} e-mails`} on this order (“${email.subject}”)`,
      after: { emailIds: moved.map((m) => m.id) },
    });
  });
}

/** The customer answered from an address that is not on their record: add it, so their mail keeps arriving here. */
export async function addSenderToCustomer(ctx: Ctx, input: { emailId: string }): Promise<{ address: string }> {
  const actor = requireUser(ctx);
  return inTx(ctx.db, async (tx) => {
    const email = await tx.emailMessage.findUnique({ where: { id: input.emailId } });
    if (!email || !email.unknownSender) throw new NotFoundError('E-mail not found.');
    if (email.orderId) await lockOrderForStaff(tx, ctx, email.orderId, 'E-mail');
    else if (!isManager(actor) && !(await tx.order.findFirst({ where: { customerId: email.customerId, ownerId: actor.id }, select: { id: true } }))) throw new NotFoundError('E-mail not found.');
    const address = email.unknownSender;
    const existing = await tx.customerEmail.findMany({ where: { customerId: email.customerId }, select: { id: true, email: true, unconfirmed: true } });
    const onRecord = existing.find((e) => e.email === address);
    if (onRecord?.unconfirmed) {
      // It came with a website enquiry; now a person says it is the customer's.
      await tx.customerEmail.update({ where: { id: onRecord.id }, data: { unconfirmed: false } });
      await audit(tx, ctx, {
        action: 'customer.update',
        entityType: 'Customer',
        entityId: email.customerId,
        orderId: email.orderId,
        customerId: email.customerId,
        summary: `Confirmed that ${address} is the customer’s address`,
        before: { email: address, unconfirmed: true },
        after: { email: address, unconfirmed: false },
      });
    } else if (!onRecord) {
      if (existing.length >= 6) throw new ValidationError('This customer already has six e-mail addresses. Remove one that is no longer used first.');
      // The same rule as when editing a customer by hand: an address on somebody else's customer is a manager's call.
      const elsewhere = await tx.customerEmail.findFirst({ where: { email: address, customerId: { not: email.customerId } }, select: { id: true } });
      if (elsewhere && !isManager(actor)) throw new ConflictError('This address is on another customer’s record. Please ask your manager.');
      await tx.customerEmail.create({ data: { id: newId('cem'), customerId: email.customerId, email: address, isPrimary: false, createdAt: nowOf(ctx) } });
      await audit(tx, ctx, {
        action: 'customer.update',
        entityType: 'Customer',
        entityId: email.customerId,
        orderId: email.orderId,
        customerId: email.customerId,
        summary: `Added the e-mail address ${address}, which the customer wrote from`,
        before: { emails: existing.map((e) => e.email) },
        after: { emails: [...existing.map((e) => e.email), address] },
      });
    }
    await tx.emailMessage.updateMany({ where: { customerId: email.customerId, unknownSender: address }, data: { unknownSender: null } });
    return { address };
  });
}

async function attachmentForFiling(db: Db, ctx: Ctx, attachmentId: string) {
  const attachment = await db.emailAttachment.findUnique({ where: { id: attachmentId }, include: { message: { select: { id: true, orderId: true, customerId: true, subject: true, sentAt: true, direction: true } } } });
  if (!attachment || attachment.message.direction !== 'IN') throw new NotFoundError('Attachment not found.');
  if (!attachment.message.orderId) {
    // Not found rather than an explanation for someone who may not see this customer's mail at all.
    if (!(await canSeeCustomerMail(ctx, attachment.message.customerId))) throw new NotFoundError('Attachment not found.');
    throw new ValidationError('Place the e-mail on an order first.');
  }
  // Not found rather than forbidden for someone who may not see the order at all.
  const order = await loadOrderState(db, attachment.message.orderId);
  if (!order || (ctx.actor.kind === 'user' && !isOrderStaff(ctx.actor, order))) throw new NotFoundError('Attachment not found.');
  if (!attachment.storageKey) throw new ValidationError(attachment.skippedReason ?? 'The CRM does not hold this file.');
  return { attachment, orderId: attachment.message.orderId, storageKey: attachment.storageKey };
}

/** Files what the customer sent into one of the order's document folders. */
export async function fileEmailAttachment(ctx: Ctx, input: { attachmentId: string; typeId: string }): Promise<{ documentId: string }> {
  const { attachment, orderId, storageKey } = await attachmentForFiling(ctx.db, ctx, input.attachmentId);
  const doc = await uploadDocument(ctx, {
    orderId,
    typeId: input.typeId,
    fileName: attachment.fileName,
    body: getStorage().createReadStream(storageKey),
    note: `From the customer’s e-mail “${attachment.message.subject || '(no subject)'}”`.slice(0, 500),
    source: 'EMAIL',
  });
  await ctx.db.emailAttachment.update({ where: { id: attachment.id }, data: { documentId: doc.id } });
  return { documentId: doc.id };
}

/** The customer sent the signed contract back by e-mail: archive it against the version they signed. */
export async function archiveContractFromAttachment(ctx: Ctx, input: { attachmentId: string; quoteId: string | null; signedOn: Date | null; replaceExisting?: boolean }): Promise<{ contractId: string }> {
  const { attachment, orderId, storageKey } = await attachmentForFiling(ctx.db, ctx, input.attachmentId);
  const staged = await stageUpload(getStorage().createReadStream(storageKey), attachment.fileName);
  // archiveContract removes the staged copy itself if it refuses.
  const contract = await archiveContract(ctx, { orderId, quoteId: input.quoteId, signedOn: input.signedOn, files: [staged], source: 'EMAIL', replaceExisting: input.replaceExisting });
  const doc = await ctx.db.contract.findUnique({ where: { id: contract.id }, select: { documentId: true } });
  if (doc?.documentId) await ctx.db.emailAttachment.update({ where: { id: attachment.id }, data: { documentId: doc.documentId } });
  return { contractId: contract.id };
}

/** For the job that reads mailboxes: the API of each stored mailbox. */
export const mailApiFactory =
  (db: Db, deps: MailDeps = {}) =>
  (account: EmailAccount): MailApi =>
    deps.apiFor ? deps.apiFor(account) : mailApiFor(db, account, deps);
