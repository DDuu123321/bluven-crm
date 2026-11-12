// Reading connected mailboxes: what is exchanged with known customers goes onto their timeline,
// everything else is left where it is and never stored.
import { Prisma, type Db, type EmailAccount, type EmailDirection } from '@bluven/db';
import {
  addActivity,
  cleanFileName,
  detectContentType,
  emailSnippet,
  fullName,
  getConfig,
  getStorage,
  htmlToText,
  inTx,
  isOpenOrder,
  isOrderStaff,
  lockOrder,
  newId,
  notifyUsers,
  nowOf,
  orderHref,
  parseMessageIds,
  safeExtension,
  stripQuotedReply,
  syncOrderStage,
  systemCtx,
  userCtx,
  withJobLock,
  type Ctx,
  type TempFile,
} from '@bluven/core';
import { MailApiError, type MailApi, type MailFolder, type MailListItem } from '../zoho/client';

export interface MailFolderRef {
  id: string;
  name: string;
  /** "filed": a folder of the owner's own that their rules move incoming mail into. */
  kind: 'inbox' | 'sent' | 'filed';
}

const PAGE_SIZE = 50;
const MAX_PAGES_PER_FOLDER = 10;
/** A message can show up in a folder a little after the time it carries. */
const OVERLAP_MS = 5 * 60_000;
const FOLDERS_TTL_MS = 60 * 60_000;
const FILED_EVERY_MS = 10 * 60_000;
const MAX_FILED_FOLDERS = 20;
/** After a customer address is added, recent mail is looked through again, at most this often. */
const RESCAN_EVERY_MS = 30 * 60_000;
const RESCAN_DAYS = 14;
const MAX_ATTACHMENTS = 25;
const MAX_TEXT = 200_000;
const MAX_HTML = 1_000_000;

export function classifyFolders(listed: MailFolder[]): MailFolderRef[] {
  const out: MailFolderRef[] = [];
  let filed = 0;
  for (const f of listed) {
    const type = f.type.toLowerCase();
    if (type === 'sent') out.push({ id: f.id, name: f.name, kind: 'sent' });
    else if (type === 'inbox') {
      // Zoho gives folders the user created the type "Inbox" as well; the real one is at /Inbox.
      const real = f.path.toLowerCase() === '/inbox' || (!f.path && f.name.toLowerCase() === 'inbox');
      if (real) out.push({ id: f.id, name: f.name, kind: 'inbox' });
      else if (filed++ < MAX_FILED_FOLDERS) out.push({ id: f.id, name: f.name, kind: 'filed' });
    }
  }
  return out;
}

const foldersOf = (account: EmailAccount): MailFolderRef[] =>
  (Array.isArray(account.folders) ? (account.folders as unknown[]) : []).filter((f): f is MailFolderRef => typeof f === 'object' && f !== null && typeof (f as MailFolderRef).id === 'string') as MailFolderRef[];

type Cursors = Record<string, string>;
const cursorsOf = (account: EmailAccount): Cursors => (typeof account.cursors === 'object' && account.cursors !== null && !Array.isArray(account.cursors) ? { ...(account.cursors as Cursors) } : {});

interface StagedAttachment {
  name: string;
  size: number;
  mimeType: string;
  temp: TempFile | null;
  skippedReason: string | null;
}

export interface MailSyncResult {
  stored: number;
  /** Messages that were looked at and are not with a known customer, or were stored before. */
  passedOver: number;
  attachments: number;
}

/** Addresses that belong to the company's own people: staff accounts and connected mailboxes. */
async function internalAddresses(db: Db): Promise<Set<string>> {
  const [users, mailboxes] = await Promise.all([db.user.findMany({ select: { email: true } }), db.emailAccount.findMany({ select: { addresses: true } })]);
  return new Set([...users.map((u) => u.email.toLowerCase()), ...mailboxes.flatMap((m) => m.addresses)]);
}

/**
 * Which order a message belongs to: the one its conversation is already on; otherwise the
 * customer's only open order; with nothing open, their latest order, so that mail after
 * handover is still seen. With several open orders a person decides.
 */
async function pickOrder(tx: Prisma.TransactionClient, customerId: string, threadOrderId: string | null): Promise<string | null> {
  const orders = await tx.order.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, select: { id: true, stage: true, sideState: true } });
  if (threadOrderId && orders.some((o) => o.id === threadOrderId)) return threadOrderId;
  const open = orders.filter(isOpenOrder);
  if (open.length === 1) return open[0]!.id;
  if (open.length === 0) return orders[0]?.id ?? null;
  return null;
}

async function stageAttachments(api: MailApi, account: EmailAccount, item: MailListItem): Promise<StagedAttachment[]> {
  const staged: StagedAttachment[] = [];
  const max = getConfig().maxUploadBytes;
  for (const info of (await api.listAttachments(account.providerAccountId, item.folderId, item.messageId)).slice(0, MAX_ATTACHMENTS)) {
    const name = cleanFileName(info.name);
    if (info.size > max) {
      staged.push({ name, size: info.size, mimeType: 'application/octet-stream', temp: null, skippedReason: `Larger than the ${Math.round(max / 1024 / 1024)} MB limit; open it in the mailbox.` });
      continue;
    }
    try {
      const temp = await getStorage().writeTemp(await api.downloadAttachment(account.providerAccountId, item.folderId, item.messageId, info.attachmentId), max);
      staged.push({ name, size: temp.sizeBytes, mimeType: detectContentType(name, temp.head), temp, skippedReason: null });
    } catch (e) {
      // An attachment that will not download must not cost us the message itself.
      if (e instanceof MailApiError && e.authFailed) throw e;
      staged.push({ name, size: info.size, mimeType: 'application/octet-stream', temp: null, skippedReason: 'Could not be fetched from the mailbox; open it there.' });
    }
  }
  return staged;
}

async function discard(staged: StagedAttachment[], committed: string[] = []): Promise<void> {
  for (const s of staged) if (s.temp) await getStorage().discard(s.temp.tempPath).catch(() => undefined);
  for (const key of committed) await getStorage().remove(key).catch(() => undefined);
}

/** Reads one message that turned up in a mailbox. Returns whether it was stored. */
async function handleMessage(ctx: Ctx, api: MailApi, account: EmailAccount & { user: { id: string; name: string; email: string; roles: string[] } }, folder: MailFolderRef, item: MailListItem, internal: Set<string>): Promise<{ stored: boolean; attachments: number }> {
  const db = ctx.db;
  const none = { stored: false, attachments: 0 };
  const known = await db.emailMessage.findUnique({ where: { accountId_providerMessageId: { accountId: account.id, providerMessageId: item.messageId } }, select: { id: true } });
  if (known) return none;

  const own = new Set(account.addresses);
  const direction: EmailDirection = folder.kind === 'sent' || (item.from !== null && own.has(item.from.address)) ? 'OUT' : 'IN';
  const others = (direction === 'OUT' ? [...item.to, ...item.cc] : [...(item.from ? [item.from] : []), ...item.to, ...item.cc]).filter((m) => !own.has(m.address) && !internal.has(m.address));
  if (direction === 'IN' && (!item.from || own.has(item.from.address) || internal.has(item.from.address))) return none; // mail between colleagues

  // Who is this with? An address on a customer's record decides; the same address on two
  // records goes to the one that had it first, as it does for leads.
  let customerId: string | null = null;
  let unknownSender: string | null = null;
  if (others.length) {
    const rows = await db.customerEmail.findMany({ where: { email: { in: others.map((m) => m.address) } }, orderBy: { createdAt: 'asc' }, select: { email: true, customerId: true } });
    const byAddress = new Map<string, string>();
    for (const r of rows) if (!byAddress.has(r.email)) byAddress.set(r.email, r.customerId);
    customerId = others.map((m) => byAddress.get(m.address)).find((id): id is string => !!id) ?? null;
  }
  let threadOrderId: string | null = null;
  if (item.threadId) {
    const earlier = await db.emailMessage.findFirst({ where: { accountId: account.id, providerThreadId: item.threadId }, orderBy: { sentAt: 'desc' }, select: { customerId: true, orderId: true } });
    if (earlier) {
      threadOrderId = earlier.customerId === customerId || !customerId ? earlier.orderId : null;
      if (!customerId) {
        // A reply in a conversation we follow, from an address that is not on the customer's record.
        customerId = earlier.customerId;
        if (direction === 'IN' && item.from) unknownSender = item.from.address;
      }
    }
  }
  if (!customerId) return none;

  const headers = await api.getHeaders(account.providerAccountId, item.folderId, item.messageId);
  const messageIdHeader = parseMessageIds(headers['message-id']?.join(' '))[0] ?? null;
  const provider = { providerMessageId: item.messageId, providerThreadId: item.threadId, providerFolderId: item.folderId };
  if (messageIdHeader) {
    // The same message reached us before: through a colleague's mailbox, or it was written in the CRM.
    const same = await db.emailMessage.findUnique({ where: { messageIdHeader }, select: { id: true, accountId: true, providerMessageId: true } });
    if (same) {
      if (same.accountId === account.id && !same.providerMessageId) await db.emailMessage.update({ where: { id: same.id }, data: provider });
      return none;
    }
  }
  if (direction === 'OUT') {
    // A message written in the CRM whose id the provider did not report when it was sent.
    const pending = await db.emailMessage.findFirst({
      where: { accountId: account.id, direction: 'OUT', providerMessageId: null, sentById: { not: null }, subject: item.subject, sentAt: { gte: new Date(item.time.getTime() - 10 * 60_000), lte: new Date(item.time.getTime() + 10 * 60_000) } },
      select: { id: true },
    });
    if (pending) {
      await db.emailMessage.update({ where: { id: pending.id }, data: { ...provider, messageIdHeader, inReplyTo: parseMessageIds(headers['in-reply-to']?.join(' '))[0] ?? null, references: parseMessageIds(headers['references']?.join(' ')) } });
      return none;
    }
  }

  const html = await api.getContent(account.providerAccountId, item.folderId, item.messageId);
  const bodyText = (html ? htmlToText(html) : item.summary).slice(0, MAX_TEXT);
  const staged = item.hasAttachment ? await stageAttachments(api, account, item) : [];
  const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId }, select: { firstName: true, lastName: true } });
  const customerName = fullName(customer);
  const id = newId('eml');
  const committed: string[] = [];

  try {
    await inTx(db, async (tx) => {
      const orderId = await pickOrder(tx, customerId!, threadOrderId);
      if (orderId) await lockOrder(tx, orderId);
      const counterpart = direction === 'IN' ? item.from! : (others[0] ?? item.to[0] ?? { name: '', address: '' });
      const who = direction === 'IN' ? counterpart.name || customerName : customerName;
      // Sent mail is the mailbox owner's doing; received mail is nobody's in the CRM.
      const actor = direction === 'OUT' ? userCtx(db, { id: account.user.id, name: account.user.name, email: account.user.email, roles: account.user.roles as never }, { now: ctx.now }) : systemCtx(db, counterpart.name || counterpart.address || customerName, ctx.now);
      const shown = stripQuotedReply(bodyText);
      const activityId = await addActivity(tx, actor, {
        customerId: customerId!,
        orderId,
        type: direction === 'IN' ? 'EMAIL_IN' : 'EMAIL_OUT',
        summary: `${direction === 'IN' ? 'Email from' : 'Email to'} ${who}: ${item.subject || '(no subject)'}`,
        body: shown.slice(0, 4000),
        occurredAt: item.time,
        payload: { emailId: id, attachments: staged.length, unknownSender },
      });
      await tx.emailMessage.create({
        data: {
          id,
          accountId: account.id,
          customerId: customerId!,
          orderId,
          direction,
          ...provider,
          messageIdHeader,
          inReplyTo: parseMessageIds(headers['in-reply-to']?.join(' '))[0] ?? null,
          references: parseMessageIds(headers['references']?.join(' ')),
          fromAddress: item.from?.address ?? account.address,
          fromName: item.from?.name ?? '',
          toAddresses: item.to.map((m) => m.address),
          ccAddresses: item.cc.map((m) => m.address),
          subject: item.subject.slice(0, 500),
          bodyText,
          bodyHtml: html ? html.slice(0, MAX_HTML) : null,
          sentAt: item.time,
          unknownSender,
          activityId,
          createdAt: nowOf(ctx),
        },
      });
      for (const s of staged) {
        const attachmentId = newId('ema');
        let storageKey: string | null = null;
        if (s.temp) {
          storageKey = `mail/${customerId}/${id}/${attachmentId}${safeExtension(s.name)}`;
          await getStorage().commit(s.temp.tempPath, storageKey);
          committed.push(storageKey);
        }
        await tx.emailAttachment.create({ data: { id: attachmentId, messageId: id, fileName: s.name, mimeType: s.mimeType, sizeBytes: s.size, storageKey, sha256: s.temp?.sha256 ?? null, skippedReason: s.skippedReason, createdAt: nowOf(ctx) } });
      }

      if (!orderId) return;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, orderNo: true, ownerId: true, leadCreatedAt: true, firstContactedAt: true, lastStaffActivityAt: true } });
      if (direction === 'OUT') {
        // Writing to the customer is contact, and it is work on the deal: counted from when the
        // message was sent, so that old mail read in later earns nobody a fresh idle clock.
        const data: Prisma.OrderUpdateInput = {};
        // Mail from before this enquiry came in (an earlier sale to the same customer) is not contact about it.
        if (!order.firstContactedAt && item.time >= order.leadCreatedAt) data.firstContactedAt = item.time;
        if (isOrderStaff({ id: account.user.id, roles: account.user.roles as never }, order) && item.time > order.lastStaffActivityAt) {
          data.lastStaffActivityAt = item.time > nowOf(ctx) ? nowOf(ctx) : item.time;
          data.idleLevel = 0;
          await tx.task.updateMany({ where: { orderId, kind: 'IDLE', status: 'OPEN', createdAt: { lte: item.time } }, data: { status: 'DONE', completedAt: nowOf(ctx), completedById: account.user.id } });
        }
        if (Object.keys(data).length) await tx.order.update({ where: { id: orderId }, data });
        await syncOrderStage(tx, actor, orderId);
      } else if (nowOf(ctx).getTime() - item.time.getTime() < 2 * 86_400_000) {
        // Shown in the CRM only: the salesperson already has the customer's e-mail itself.
        await notifyUsers(tx, actor, [order.ownerId], {
          type: 'mail.received',
          title: `${order.orderNo}: email from ${who}`,
          body: `${item.subject}\n${emailSnippet(shown, 200)}`,
          href: orderHref(orderId),
          orderId,
          inAppOnly: true,
        });
      }
    });
  } catch (e) {
    await discard(staged, committed);
    // Two readers of the same message (two mailboxes it reached) raced: one of them stored it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return none;
    throw e;
  }
  return { stored: true, attachments: staged.filter((s) => s.temp).length };
}

/**
 * Reads what is new in one mailbox. Folder by folder, newest message first, back to the point
 * reached last time. Progress is saved per folder, so a failure half-way repeats little.
 */
export async function syncMailbox(ctx: Ctx, accountId: string, api: MailApi): Promise<MailSyncResult> {
  const db = ctx.db;
  const now = nowOf(ctx);
  let account = await db.emailAccount.findUniqueOrThrow({ where: { id: accountId }, include: { user: { select: { id: true, name: true, email: true, roles: true } } } });
  const result: MailSyncResult = { stored: 0, passedOver: 0, attachments: 0 };

  let folders = foldersOf(account);
  if (!folders.length || !account.foldersCheckedAt || now.getTime() - account.foldersCheckedAt.getTime() > FOLDERS_TTL_MS) {
    folders = classifyFolders(await api.listFolders(account.providerAccountId));
    account = await db.emailAccount.update({ where: { id: accountId }, data: { folders: folders as unknown as Prisma.InputJsonValue, foldersCheckedAt: now }, include: { user: { select: { id: true, name: true, email: true, roles: true } } } });
  }
  const cursors = cursorsOf(account);

  // A customer address added since the last look means recent mail may now belong to someone.
  const newestAddress = await db.customerEmail.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const matchedUpTo = cursors.__matched ? Date.parse(cursors.__matched) : 0;
  const lastRescan = cursors.__rescan ? Date.parse(cursors.__rescan) : 0;
  const rescan = !!newestAddress && newestAddress.createdAt.getTime() > matchedUpTo && matchedUpTo > 0 && now.getTime() - lastRescan >= RESCAN_EVERY_MS;
  const rescanFrom = new Date(Math.max(account.syncFrom.getTime(), now.getTime() - RESCAN_DAYS * 86_400_000));

  const readFiled = !account.filedFoldersAt || now.getTime() - account.filedFoldersAt.getTime() >= FILED_EVERY_MS;
  const internal = await internalAddresses(db);

  for (const folder of folders) {
    if (folder.kind === 'filed' && !readFiled) continue;
    const cursor = cursors[folder.id] ? new Date(cursors[folder.id]!) : null;
    const since = rescan ? rescanFrom : cursor ? new Date(Math.max(account.syncFrom.getTime(), cursor.getTime() - OVERLAP_MS)) : account.syncFrom;
    let newest = cursor;
    let done = false;
    for (let page = 0; page < MAX_PAGES_PER_FOLDER && !done; page++) {
      const items = await api.listMessages(account.providerAccountId, folder.id, { start: page * PAGE_SIZE + 1, limit: PAGE_SIZE });
      for (const item of items) {
        if (item.time < since) {
          done = true;
          break;
        }
        const handled = await handleMessage(ctx, api, account, folder, item, internal);
        if (handled.stored) result.stored++;
        else result.passedOver++;
        result.attachments += handled.attachments;
        if (!newest || item.time > newest) newest = item.time;
      }
      if (items.length < PAGE_SIZE) done = true;
    }
    if (newest) cursors[folder.id] = newest.toISOString();
    await db.emailAccount.update({ where: { id: accountId }, data: { cursors } });
  }

  if (newestAddress && (rescan || matchedUpTo === 0)) cursors.__matched = newestAddress.createdAt.toISOString();
  if (rescan) cursors.__rescan = now.toISOString();
  await db.emailAccount.update({ where: { id: accountId }, data: { cursors, ...(readFiled ? { filedFoldersAt: now } : {}) } });
  return result;
}

export interface MailSyncSummary {
  mailboxes: number;
  stored: number;
  failed: number;
}

/**
 * Reads every connected mailbox in turn. A mailbox that fails is noted and does not hold up the
 * others; one whose permission was withdrawn is switched off and its owner is asked to connect again.
 */
export async function syncAllMailboxes(ctx: Ctx, apiFor: (account: EmailAccount) => MailApi): Promise<MailSyncSummary> {
  const summary: MailSyncSummary = { mailboxes: 0, stored: 0, failed: 0 };
  await withJobLock(ctx.db, 760301, async () => {
    const accounts = await ctx.db.emailAccount.findMany({ where: { needsReconnect: false, user: { isActive: true } }, orderBy: { lastSyncAt: { sort: 'asc', nulls: 'first' } } });
    for (const account of accounts) {
      summary.mailboxes++;
      const now = nowOf(ctx);
      try {
        const r = await syncMailbox(ctx, account.id, apiFor(account));
        summary.stored += r.stored;
        await ctx.db.emailAccount.update({ where: { id: account.id }, data: { lastSyncAt: now, lastOkAt: now, lastError: null, consecutiveFailures: 0 } });
      } catch (e) {
        summary.failed++;
        const message = e instanceof Error ? e.message : String(e);
        const lost = e instanceof MailApiError && e.authFailed;
        await ctx.db.emailAccount.update({ where: { id: account.id }, data: { lastSyncAt: now, lastError: message.slice(0, 500), consecutiveFailures: { increment: 1 }, needsReconnect: lost } });
        if (lost) {
          await notifyUsers(ctx.db, ctx, [account.userId], {
            type: 'mail.reconnect',
            title: 'Your mailbox needs to be connected again',
            body: `The CRM can no longer read ${account.address}. Customer e-mails are not reaching the timeline until you connect it again under your account.`,
            href: '/account/email',
          });
        }
        if (!(e instanceof MailApiError)) console.error(`[mail] reading ${account.address} failed`, e);
      }
    }
    return true;
  });
  return summary;
}
