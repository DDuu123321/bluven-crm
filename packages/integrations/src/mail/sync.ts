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
  isActiveOrder,
  isOrderStaff,
  lockOrder,
  managerIds,
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
import { MAX_READ_ATTEMPTS, problemsOf, removeOrphanedMailboxes, type MailDeps, type ProblemMessage } from './accounts';

export interface MailFolderRef {
  id: string;
  name: string;
  /** "filed": a folder of the owner's own that their rules move incoming mail into. */
  kind: 'inbox' | 'sent' | 'filed';
}

/** What one look at a folder asks for when it is up to date, and when it has a stretch to catch up on. */
const STEADY_PAGE = 50;
const CATCHUP_PAGE = 200;
/** A look that has not reached its starting point after this many messages stops there. */
const MAX_MESSAGES_PER_PASS = 5000;
/** A message can show up in a folder a little after the time it carries. */
const OVERLAP_MS = 5 * 60_000;
const FOLDERS_TTL_MS = 60 * 60_000;
const MAX_FILED_FOLDERS = 20;
/** After a customer address or a customer of the owner's appears, recent mail is looked through again, per folder at most this often. */
const RESCAN_EVERY_MS = 30 * 60_000;
const RESCAN_DAYS = 14;
const MAX_ATTACHMENTS = 25;
const MAX_TEXT = 200_000;
const MAX_HTML = 1_000_000;
/** The most requests one mailbox gets in one round, so a mailbox with a backlog cannot keep the others waiting. */
const MAX_CALLS_PER_MAILBOX = 30;
/** What storing one message costs at least: its headers, its content, its list of attachments. */
const CALLS_PER_MESSAGE = 3;
/** One sender cannot fill the disk: beyond this much in a day, attachments are left in the mailbox. */
const MAX_STORED_PER_CUSTOMER_PER_DAY = 250 * 1024 * 1024;
/** An attachment that could not be fetched is tried again this long after the message arrived. */
const FETCH_RETRY_AFTER_MS = [5 * 60_000, 30 * 60_000, 3 * 3_600_000];
/** No new mailbox is started once a round has taken this long; the rest are first in the next round. */
const ROUND_BUDGET_MS = 8 * 60_000;
/** A message that keeps failing in a way that could be the service's doing is given up on after this long. */
const SUSPECT_GIVE_UP_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

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

/** How far one folder has been read. */
interface FolderProgress {
  /** The time of the newest message dealt with, when the last look reached its starting point. */
  at?: string;
  /** The state of the customer records (see relationWatermark) that recent mail was last looked through for. */
  matched?: string;
  rescannedAt?: string;
}

interface Progress {
  folders: Record<string, FolderProgress>;
  /** Which of the owner's own folders is read next: one a round, in turn. */
  filedTurn: number;
}

function progressOf(account: EmailAccount): Progress {
  const raw = typeof account.cursors === 'object' && account.cursors !== null && !Array.isArray(account.cursors) ? (account.cursors as Record<string, unknown>) : {};
  const folders: Record<string, FolderProgress> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('__')) continue;
    // Until November 2026 a folder's entry was the time alone.
    if (typeof value === 'string') folders[key] = { at: value };
    else if (typeof value === 'object' && value !== null) folders[key] = value as FolderProgress;
  }
  return { folders, filedTurn: typeof raw.__filedTurn === 'number' ? raw.__filedTurn : 0 };
}

const stored = (p: Progress): Prisma.InputJsonValue => ({ ...p.folders, __filedTurn: p.filedTurn }) as unknown as Prisma.InputJsonValue;

interface StagedAttachment {
  name: string;
  size: number;
  mimeType: string;
  temp: TempFile | null;
  skippedReason: string | null;
  /** Kept when fetching failed in a way that may pass, so it can be tried again. */
  providerAttachmentId: string | null;
}

export interface MailSyncResult {
  stored: number;
  /** Messages that were looked at and are not with a customer of this mailbox's owner, or were stored before. */
  passedOver: number;
  attachments: number;
}

type SyncAccount = EmailAccount & { user: { id: string; name: string; email: string; roles: string[] } };

/** Addresses that belong to the company's own people: staff accounts and connected mailboxes. */
async function internalAddresses(db: Db): Promise<Set<string>> {
  const [users, mailboxes] = await Promise.all([db.user.findMany({ select: { email: true } }), db.emailAccount.findMany({ select: { addresses: true } })]);
  return new Set([...users.map((u) => u.email.toLowerCase()), ...mailboxes.flatMap((m) => m.addresses)]);
}

/**
 * The customers a mailbox's owner works with or worked with: they own or owned one of the
 * customer's orders, or wrote to the customer from the CRM. Only mail with these customers is
 * kept from the owner's mailbox, unless the owner chose to share all of it. Without this rule
 * anyone able to put an address on a customer's record could have a colleague's mail with that
 * address filed where they can read it.
 */
const involvedWith = (userId: string): Prisma.CustomerWhereInput => ({
  OR: [{ orders: { some: { ownerId: userId } } }, { activities: { some: { type: 'ASSIGNMENT', payload: { path: ['to'], equals: userId } } } }, { emailMessages: { some: { sentById: userId } } }],
});

/**
 * Changes whenever recent mail in this mailbox may newly belong to someone: an address was added
 * to a customer the mailbox is read for, the owner was given an order, or the owner changed how
 * much of the mailbox is kept. Folders remember the value they were last looked through for.
 */
async function relationWatermark(db: Db, account: SyncAccount): Promise<string> {
  let newest = account.scopeChangedAt?.getTime() ?? 0;
  if (account.scope === 'ALL') {
    const address = await db.customerEmail.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    newest = Math.max(newest, address?.createdAt.getTime() ?? 0);
  } else {
    // From the owner's orders outwards, which is a short way in however many customers there are.
    const [row] = await db.$queryRaw<{ address: Date | null; assigned: Date | null }[]>(
      Prisma.sql`SELECT max(e."createdAt") AS "address", max(o."assignedAt") AS "assigned" FROM "Order" o LEFT JOIN "CustomerEmail" e ON e."customerId" = o."customerId" WHERE o."ownerId" = ${account.userId}`,
    );
    newest = Math.max(newest, row?.address?.getTime() ?? 0, row?.assigned?.getTime() ?? 0);
  }
  return newest ? new Date(newest).toISOString() : '';
}

/**
 * Which order a message belongs to: the one its conversation is already on; otherwise the
 * customer's only order that is still being worked on, by sales or by operations; with none,
 * their latest order, so that mail after a job is closed is still seen. With several a person
 * decides.
 */
async function pickOrder(tx: Prisma.TransactionClient, customerId: string, threadOrderId: string | null): Promise<string | null> {
  const orders = await tx.order.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, select: { id: true, stage: true, sideState: true } });
  if (threadOrderId && orders.some((o) => o.id === threadOrderId)) return threadOrderId;
  const open = orders.filter(isActiveOrder);
  if (open.length === 1) return open[0]!.id;
  if (open.length === 0) return orders[0]?.id ?? null;
  return null;
}

/** PostgreSQL does not take a NUL character in text, and one in a subject would stop the message from ever being stored. */
const clean = (text: string): string => text.replaceAll('\u0000', '');

async function stageAttachments(ctx: Ctx, api: MailApi, account: EmailAccount, item: MailListItem, customerId: string): Promise<StagedAttachment[]> {
  const staged: StagedAttachment[] = [];
  const max = getConfig().maxUploadBytes;
  const today = await ctx.db.emailAttachment.aggregate({ _sum: { sizeBytes: true }, where: { storageKey: { not: null }, createdAt: { gte: new Date(nowOf(ctx).getTime() - DAY_MS) }, message: { customerId, direction: 'IN' } } });
  let room = MAX_STORED_PER_CUSTOMER_PER_DAY - (today._sum.sizeBytes ?? 0);
  for (const info of (await api.listAttachments(account.providerAccountId, item.folderId, item.messageId)).slice(0, MAX_ATTACHMENTS)) {
    const name = cleanFileName(clean(info.name));
    const skip = (skippedReason: string, again = false) => staged.push({ name, size: info.size, mimeType: 'application/octet-stream', temp: null, skippedReason, providerAttachmentId: again ? info.attachmentId : null });
    if (info.size > max) {
      skip(`Larger than the ${Math.round(max / 1024 / 1024)} MB limit; open it in the mailbox.`);
      continue;
    }
    if (info.size > room) {
      skip(`This customer has sent more than ${Math.round(MAX_STORED_PER_CUSTOMER_PER_DAY / 1024 / 1024)} MB of attachments within a day; open it in the mailbox.`);
      continue;
    }
    try {
      const temp = await getStorage().writeTemp(await api.downloadAttachment(account.providerAccountId, item.folderId, item.messageId, info.attachmentId), max);
      room -= temp.sizeBytes;
      staged.push({ name, size: temp.sizeBytes, mimeType: detectContentType(name, temp.head), temp, skippedReason: null, providerAttachmentId: null });
    } catch (e) {
      // An attachment that will not download must not cost us the message itself.
      if (e instanceof MailApiError && (e.authFailed || e.throttled || e.setupFailed)) throw e;
      skip('Could not be fetched from the mailbox yet. The CRM will try again; until then, open it in the mailbox.', true);
    }
  }
  return staged;
}

async function discard(staged: StagedAttachment[], committed: string[] = []): Promise<void> {
  for (const s of staged) if (s.temp) await getStorage().discard(s.temp.tempPath).catch(() => undefined);
  for (const key of committed) await getStorage().remove(key).catch(() => undefined);
}

/** What the customer records say about the addresses on one page of messages. */
interface PageFacts {
  /** By provider message id: the message is stored already. */
  known: Map<string, { id: string; providerThreadId: string | null; messageIdHeader: string | null; sentById: string | null }>;
  /** By address: the customer who has had it on record longest. */
  byAddress: Map<string, { customerId: string; unconfirmed: boolean }>;
  /** By the provider's conversation id: the newest stored message of that conversation in this mailbox. */
  threads: Map<string, { customerId: string; orderId: string | null }>;
}

async function factsFor(db: Db, account: SyncAccount, items: MailListItem[]): Promise<PageFacts> {
  const facts: PageFacts = { known: new Map(), byAddress: new Map(), threads: new Map() };
  if (items.length === 0) return facts;
  for (const row of await db.emailMessage.findMany({ where: { accountId: account.id, providerMessageId: { in: items.map((i) => i.messageId) } }, select: { id: true, providerMessageId: true, providerThreadId: true, messageIdHeader: true, sentById: true } })) {
    facts.known.set(row.providerMessageId!, row);
  }
  const fresh = items.filter((i) => !facts.known.has(i.messageId));
  const addresses = [...new Set(fresh.flatMap((i) => [...(i.from ? [i.from.address] : []), ...i.to.map((m) => m.address), ...i.cc.map((m) => m.address)]))];
  if (addresses.length) {
    // The same address on two records goes to the one that had it first, as it does for leads.
    for (const row of await db.customerEmail.findMany({ where: { email: { in: addresses } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { email: true, customerId: true, unconfirmed: true } })) {
      if (!facts.byAddress.has(row.email)) facts.byAddress.set(row.email, { customerId: row.customerId, unconfirmed: row.unconfirmed });
    }
  }
  const threadIds = [...new Set(fresh.map((i) => i.threadId).filter((t): t is string => !!t))];
  if (threadIds.length) {
    // Zoho gives a conversation the id of its first message, and gives it only once there is a
    // second one: the first is found by its own id.
    const rows = await db.emailMessage.findMany({
      where: { accountId: account.id, OR: [{ providerThreadId: { in: threadIds } }, { providerMessageId: { in: threadIds } }] },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      select: { customerId: true, orderId: true, providerThreadId: true, providerMessageId: true },
    });
    for (const row of rows) {
      for (const key of new Set([row.providerThreadId, row.providerMessageId])) if (key && threadIds.includes(key)) facts.threads.set(key, { customerId: row.customerId, orderId: row.orderId });
    }
  }
  return facts;
}

interface Placement {
  customerId: string;
  direction: EmailDirection;
  /** A sender whose address is not, or not confirmed to be, the customer's. */
  unknownSender: string | null;
  threadOrderId: string | null;
  /** Placed only because its conversation is followed: the addresses alone would not have matched. */
  viaThread: boolean;
}

/** Whose mail this is, going by what the list shows. Null for mail that is not with a customer. */
export function placeMessage(item: MailListItem, folder: MailFolderRef, own: Set<string>, internal: Set<string>, facts: Pick<PageFacts, 'byAddress' | 'threads'>): Placement | null {
  const fromOwn = !!item.from && own.has(item.from.address);
  // "Sent" is what the provider put in the sent folder, or what the owner moved from there into a
  // folder of their own. A message in the inbox that claims to be from the owner is not proof of
  // anything: anybody can write that name into a message.
  const direction: EmailDirection = folder.kind === 'sent' || (folder.kind === 'filed' && fromOwn) ? 'OUT' : 'IN';
  if (direction === 'IN' && (!item.from || fromOwn || internal.has(item.from.address))) return null; // between colleagues, or a copy of one's own message
  const outside = (list: { address: string }[]) => list.filter((m) => !own.has(m.address) && !internal.has(m.address));
  const onRecord = (list: { address: string }[]) => outside(list).map((m) => facts.byAddress.get(m.address)).find((hit) => !!hit);

  let customerId: string | null = null;
  let unknownSender: string | null = null;
  if (direction === 'OUT') {
    customerId = onRecord([...item.to, ...item.cc])?.customerId ?? null;
  } else {
    const sender = facts.byAddress.get(item.from!.address);
    if (sender) {
      customerId = sender.customerId;
      if (sender.unconfirmed) unknownSender = item.from!.address;
    } else {
      // Someone we do not know wrote and addressed a customer as well: it concerns that customer, but it is not from them.
      const named = onRecord([...item.to, ...item.cc]);
      if (named) {
        customerId = named.customerId;
        unknownSender = item.from!.address;
      }
    }
  }
  const earlier = item.threadId ? facts.threads.get(item.threadId) : undefined;
  let viaThread = false;
  if (earlier && !customerId) {
    // A reply in a conversation we follow, from or to an address that is not on the customer's record.
    customerId = earlier.customerId;
    viaThread = true;
    if (direction === 'IN') unknownSender = item.from!.address;
  }
  if (!customerId) return null;
  return { customerId, direction, unknownSender, threadOrderId: earlier && earlier.customerId === customerId ? earlier.orderId : null, viaThread };
}

/** Stores one message that belongs to a customer. Returns whether it was new. */
async function storeMessage(ctx: Ctx, api: MailApi, account: SyncAccount, item: MailListItem, placed: Placement): Promise<{ stored: boolean; attachments: number }> {
  const db = ctx.db;
  const none = { stored: false, attachments: 0 };
  const { customerId, direction, unknownSender } = placed;
  const own = new Set(account.addresses);

  const headers = await api.getHeaders(account.providerAccountId, item.folderId, item.messageId);
  const messageIdHeader = parseMessageIds(headers['message-id']?.join(' '))[0] ?? null;
  const inReplyTo = parseMessageIds(headers['in-reply-to']?.join(' '))[0] ?? null;
  const references = parseMessageIds(headers['references']?.join(' '));
  const provider = { providerMessageId: item.messageId, providerThreadId: item.threadId ?? item.messageId, providerFolderId: item.folderId };
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
      await db.emailMessage.update({ where: { id: pending.id }, data: { ...provider, messageIdHeader, inReplyTo, references } });
      return none;
    }
  }

  // Where the provider's conversation id does not lead, the message's own headers may: it answers something we hold.
  let threadOrderId = placed.threadOrderId;
  if (!threadOrderId && (inReplyTo || references.length)) {
    const answered = await db.emailMessage.findFirst({ where: { customerId, orderId: { not: null }, messageIdHeader: { in: [...new Set([...(inReplyTo ? [inReplyTo] : []), ...references])] } }, orderBy: { sentAt: 'desc' }, select: { orderId: true } });
    threadOrderId = answered?.orderId ?? null;
  }

  const html = await api.getContent(account.providerAccountId, item.folderId, item.messageId);
  const bodyText = clean(html ? htmlToText(html.slice(0, MAX_HTML)) : item.summary).slice(0, MAX_TEXT);
  const subject = clean(item.subject).slice(0, 500);
  const staged = item.hasAttachment ? await stageAttachments(ctx, api, account, item, customerId) : [];
  const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId }, select: { firstName: true, lastName: true } });
  const customerName = fullName(customer);
  const id = newId('eml');
  const committed: string[] = [];

  try {
    await inTx(db, async (tx) => {
      const orderId = await pickOrder(tx, customerId, threadOrderId);
      if (orderId) await lockOrder(tx, orderId);
      const others = (direction === 'OUT' ? [...item.to, ...item.cc] : [item.from!, ...item.to, ...item.cc]).filter((m) => !own.has(m.address));
      const counterpart = direction === 'IN' ? item.from! : (others[0] ?? item.to[0] ?? { name: '', address: '' });
      // A name is whatever its sender typed: for someone who is not confirmed to be the customer the address goes with it.
      const who = clean(direction === 'OUT' ? customerName : unknownSender ? (counterpart.name ? `${counterpart.name} <${counterpart.address}>` : counterpart.address) : counterpart.name || customerName);
      // Sent mail is the mailbox owner's doing; received mail is nobody's in the CRM.
      const actor = direction === 'OUT' ? userCtx(db, { id: account.user.id, name: account.user.name, email: account.user.email, roles: account.user.roles as never }, { now: ctx.now }) : systemCtx(db, who || counterpart.address || customerName, ctx.now);
      const shown = stripQuotedReply(bodyText);
      const activityId = await addActivity(tx, actor, {
        customerId,
        orderId,
        type: direction === 'IN' ? 'EMAIL_IN' : 'EMAIL_OUT',
        summary: `${direction === 'IN' ? 'Email from' : 'Email to'} ${who}: ${subject || '(no subject)'}`,
        body: shown.slice(0, 4000),
        occurredAt: item.time,
        payload: { emailId: id, attachments: staged.length, unknownSender },
      });
      await tx.emailMessage.create({
        data: {
          id,
          accountId: account.id,
          customerId,
          orderId,
          direction,
          ...provider,
          messageIdHeader,
          inReplyTo,
          references,
          fromAddress: item.from?.address ?? account.address,
          fromName: clean(item.from?.name ?? ''),
          toAddresses: item.to.map((m) => m.address),
          ccAddresses: item.cc.map((m) => m.address),
          subject,
          bodyText,
          bodyHtml: html ? clean(html).slice(0, MAX_HTML) : null,
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
        await tx.emailAttachment.create({
          data: { id: attachmentId, messageId: id, fileName: s.name, mimeType: s.mimeType, sizeBytes: s.size, storageKey, sha256: s.temp?.sha256 ?? null, skippedReason: s.skippedReason, providerAttachmentId: s.providerAttachmentId, createdAt: nowOf(ctx) },
        });
      }

      const recent = nowOf(ctx).getTime() - item.time.getTime() < 2 * DAY_MS;
      if (!orderId) {
        // The customer has several open orders and nobody has said which one this is about. The
        // people who could say are told; until then it is on no order's timeline.
        if (direction === 'IN' && recent) {
          const open = (await tx.order.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, select: { id: true, stage: true, sideState: true, ownerId: true } })).filter(isActiveOrder);
          const owners = [...new Set(open.map((o) => o.ownerId).filter((o): o is string => !!o))];
          for (const ownerId of owners.length ? owners : await managerIds(tx)) {
            const theirs = open.find((o) => o.ownerId === ownerId) ?? open[0];
            await notifyUsers(tx, actor, [ownerId], {
              type: 'mail.unplaced',
              title: `Email from ${who}: choose the order it is about`,
              body: `${customerName} has more than one open order.\n${subject}\n${emailSnippet(shown, 200)}`,
              href: theirs ? `${orderHref(theirs.id)}?tab=email` : undefined,
              orderId: theirs?.id ?? null,
              inAppOnly: true,
            });
          }
        }
        return;
      }
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
      } else if (recent) {
        // Shown in the CRM only: the salesperson already has the customer's e-mail itself.
        await notifyUsers(tx, actor, [order.ownerId], {
          type: 'mail.received',
          title: `${order.orderNo}: email from ${who}`,
          body: `${subject}\n${emailSnippet(shown, 200)}`,
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

/** Counts the requests made through an API, so one mailbox's share of a round can be limited. */
function counted(api: MailApi): { api: MailApi; calls: () => number } {
  let calls = 0;
  const proxy = new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { api: proxy, calls: () => calls };
}

/** Whether the failure says something about the service or the mailbox as a whole, not about one message. */
const aboutTheService = (e: unknown): boolean => e instanceof MailApiError && (e.authFailed || e.throttled || e.setupFailed);

/**
 * Tries again to fetch attachments that could not be fetched when their message was stored.
 * Three tries, spread over a few hours; after that the file stays in the mailbox only.
 */
async function retryAttachments(ctx: Ctx, api: MailApi, account: SyncAccount, callsLeft: () => number): Promise<number> {
  const now = nowOf(ctx);
  const waiting = await ctx.db.emailAttachment.findMany({
    where: { storageKey: null, providerAttachmentId: { not: null }, fetchAttempts: { lt: FETCH_RETRY_AFTER_MS.length }, message: { accountId: account.id, providerMessageId: { not: null }, providerFolderId: { not: null } } },
    include: { message: { select: { id: true, customerId: true, providerMessageId: true, providerFolderId: true, createdAt: true } } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  let fetched = 0;
  for (const a of waiting) {
    if (callsLeft() < 1) break;
    if (now.getTime() - a.message.createdAt.getTime() < FETCH_RETRY_AFTER_MS[a.fetchAttempts]!) continue;
    let temp: TempFile | null = null;
    try {
      temp = await getStorage().writeTemp(await api.downloadAttachment(account.providerAccountId, a.message.providerFolderId!, a.message.providerMessageId!, a.providerAttachmentId!), getConfig().maxUploadBytes);
      const storageKey = `mail/${a.message.customerId}/${a.message.id}/${a.id}${safeExtension(a.fileName)}`;
      await getStorage().commit(temp.tempPath, storageKey);
      // The assistant set it aside as a file it could not see: now it can.
      await ctx.db.emailAttachment.update({
        where: { id: a.id },
        data: { storageKey, sha256: temp.sha256, sizeBytes: temp.sizeBytes, mimeType: detectContentType(a.fileName, temp.head), skippedReason: null, providerAttachmentId: null, aiReadAt: null, aiKind: null, aiConfidence: null, aiNote: null },
      });
      fetched++;
    } catch (e) {
      if (temp) await getStorage().discard(temp.tempPath).catch(() => undefined);
      if (aboutTheService(e)) throw e;
      const last = a.fetchAttempts + 1 >= FETCH_RETRY_AFTER_MS.length;
      await ctx.db.emailAttachment.update({
        where: { id: a.id },
        data: { fetchAttempts: { increment: 1 }, ...(last ? { providerAttachmentId: null, skippedReason: 'Could not be fetched from the mailbox; open it there.' } : {}) },
      });
    }
  }
  return fetched;
}

/**
 * Reads what is new in one mailbox, within `maxCalls` requests. Folder by folder, newest message
 * first, back to the point reached last time. A folder's progress moves on only when a look at it
 * got all the way there; one that ran out of requests starts from the top again next time, and
 * what it already stored is recognised without asking the provider again.
 */
export async function syncMailbox(ctx: Ctx, accountId: string, api: MailApi, opts: { maxCalls?: number } = {}): Promise<MailSyncResult> {
  const db = ctx.db;
  const now = nowOf(ctx);
  const include = { user: { select: { id: true, name: true, email: true, roles: true } } } as const;
  let account: SyncAccount = await db.emailAccount.findUniqueOrThrow({ where: { id: accountId }, include });
  const result: MailSyncResult = { stored: 0, passedOver: 0, attachments: 0 };
  const budget = opts.maxCalls ?? MAX_CALLS_PER_MAILBOX;
  const meter = counted(api);
  const callsLeft = () => budget - meter.calls();

  let folders = foldersOf(account);
  if (!folders.length || !account.foldersCheckedAt || now.getTime() - account.foldersCheckedAt.getTime() > FOLDERS_TTL_MS) {
    folders = classifyFolders(await meter.api.listFolders(account.providerAccountId));
    account = await db.emailAccount.update({ where: { id: accountId }, data: { folders: folders as unknown as Prisma.InputJsonValue, foldersCheckedAt: now }, include });
  }
  const progress = progressOf(account);
  const problems = problemsOf(account);
  const watermark = await relationWatermark(db, account);
  const rescanFrom = new Date(Math.max(account.syncFrom.getTime(), now.getTime() - RESCAN_DAYS * DAY_MS));
  const internal = await internalAddresses(db);
  const own = new Set(account.addresses);
  const involved = new Map<string, boolean>();
  const isInvolved = async (customerId: string): Promise<boolean> => {
    if (account.scope === 'ALL') return true;
    if (!involved.has(customerId)) involved.set(customerId, (await db.customer.count({ where: { id: customerId, ...involvedWith(account.userId) } })) > 0);
    return involved.get(customerId)!;
  };
  const saveProblems = () => {
    // Old entries go, so the list cannot grow for ever.
    const kept = Object.entries(problems)
      .filter(([, p]) => !p.at || now.getTime() - Date.parse(p.at) < 30 * DAY_MS)
      .slice(-100);
    return Object.fromEntries(kept) as unknown as Prisma.InputJsonValue;
  };

  // The inbox and the sent folder every time; the owner's own folders one a round, in turn.
  const filed = folders.filter((f) => f.kind === 'filed');
  const turn = filed.length ? filed[progress.filedTurn % filed.length] : undefined;
  progress.filedTurn = filed.length ? (progress.filedTurn + 1) % filed.length : 0;
  const toRead = folders.filter((f) => f.kind !== 'filed' || f === turn);

  for (const folder of toRead) {
    if (callsLeft() < 1) break;
    const state = (progress.folders[folder.id] ??= {});
    const cursor = state.at ? new Date(state.at) : null;
    const rescan = watermark !== (state.matched ?? '') && (!state.rescannedAt || now.getTime() - Date.parse(state.rescannedAt) >= RESCAN_EVERY_MS);
    const since = !cursor ? account.syncFrom : rescan ? rescanFrom : new Date(Math.max(account.syncFrom.getTime(), cursor.getTime() - OVERLAP_MS));
    const pageSize = now.getTime() - since.getTime() > DAY_MS ? CATCHUP_PAGE : STEADY_PAGE;
    let newest = cursor;
    let seen = 0;
    /** The look got back to where it started from, with nothing left undone on the way. */
    let complete = false;
    let unfinished = false;
    /** Messages that failed in a way that may be the service's doing; settled once another message has gone through. */
    const suspects: { item: MailListItem; error: string }[] = [];
    /**
     * Notes a failed attempt. One that is plainly about the message counts at once; one that may
     * be the service's doing counts only after it has gone on for hours, so that an outage does
     * not make the CRM give up on mail that was fine.
     */
    const note = (item: MailListItem, error: string, aboutTheMessage: boolean) => {
      const before = problems[item.messageId];
      const since = before?.since ?? now.toISOString();
      const attempts = aboutTheMessage ? (before?.attempts ?? 0) + 1 : now.getTime() - Date.parse(since) > SUSPECT_GIVE_UP_MS ? MAX_READ_ATTEMPTS : (before?.attempts ?? 0);
      problems[item.messageId] = { attempts, error: error.slice(0, 300), subject: clean(item.subject).slice(0, 200), at: item.time.toISOString(), since } satisfies ProblemMessage;
    };

    pages: for (let start = 1; seen < MAX_MESSAGES_PER_PASS; start += pageSize) {
      const page = await meter.api.listMessages(account.providerAccountId, folder.id, { start, limit: pageSize });
      const items = page.items.filter((i) => i.time >= since);
      const facts = await factsFor(db, account, items);
      for (const item of items) {
        seen++;
        if (!newest || item.time > newest) newest = item.time;
        const known = facts.known.get(item.messageId);
        if (known) {
          // Stored before. Its conversation id may only have been given since, and a message written
          // in the CRM gets its Message-ID here, so that the customer's answer finds it.
          const thread = item.threadId ?? item.messageId;
          const data: Prisma.EmailMessageUpdateInput = {};
          if (known.providerThreadId !== thread && (item.threadId || !known.providerThreadId)) data.providerThreadId = thread;
          if (!known.messageIdHeader && known.sentById && callsLeft() >= 1) {
            const header = parseMessageIds((await meter.api.getHeaders(account.providerAccountId, item.folderId, item.messageId))['message-id']?.join(' '))[0];
            if (header && !(await db.emailMessage.findUnique({ where: { messageIdHeader: header }, select: { id: true } }))) data.messageIdHeader = header;
          }
          if (Object.keys(data).length) await db.emailMessage.update({ where: { id: known.id }, data: { ...data, providerFolderId: item.folderId } });
          result.passedOver++;
          continue;
        }
        if ((problems[item.messageId]?.attempts ?? 0) >= MAX_READ_ATTEMPTS) {
          result.passedOver++;
          continue;
        }
        const placed = placeMessage(item, folder, own, internal, facts);
        if (!placed || (!placed.viaThread && !(await isInvolved(placed.customerId)))) {
          result.passedOver++;
          continue;
        }
        if (callsLeft() < CALLS_PER_MESSAGE) {
          unfinished = true;
          break pages;
        }
        try {
          const handled = await storeMessage(ctx, meter.api, account, item, placed);
          if (handled.stored) result.stored++;
          else result.passedOver++;
          result.attachments += handled.attachments;
          delete problems[item.messageId];
          // The service works, so what failed before this was about those messages themselves.
          for (const s of suspects.splice(0)) note(s.item, s.error, true);
        } catch (e) {
          if (aboutTheService(e)) throw e;
          const message = e instanceof Error ? e.message : String(e);
          unfinished = true;
          if (e instanceof MailApiError && e.retryable) {
            // Twice in a row without a success in between: the service is having trouble, and no message is to blame.
            if (suspects.length) throw e;
            suspects.push({ item, error: message });
          } else {
            note(item, message, true);
            if (!(e instanceof MailApiError)) console.error(`[mail] a message in ${account.address} could not be stored`, e);
          }
        }
      }
      // The end of the folder, or everything from here on is older than where the look began.
      if (page.received < pageSize || items.length < page.items.length) {
        complete = !unfinished;
        break;
      }
    }
    if (seen >= MAX_MESSAGES_PER_PASS && !unfinished) complete = true; // more mail than the CRM reads back: carry on from the newest
    for (const s of suspects) note(s.item, s.error, false);
    if (complete) {
      if (newest) state.at = newest.toISOString();
      if (rescan || !cursor) {
        state.matched = watermark;
        state.rescannedAt = now.toISOString();
      }
    }
    await db.emailAccount.update({ where: { id: accountId }, data: { cursors: stored(progress), problemMessages: saveProblems() } });
  }

  result.attachments += await retryAttachments(ctx, meter.api, account, callsLeft);
  await db.emailAccount.update({ where: { id: accountId }, data: { cursors: stored(progress), problemMessages: saveProblems() } });
  return result;
}

export interface MailSyncSummary {
  mailboxes: number;
  stored: number;
  failed: number;
  /** Mailboxes removed because their owner may no longer have one. */
  removed: number;
  /** Set while reading is paused because the provider asked us to slow down, or does not accept the server's settings. */
  pausedUntil: Date | null;
}

const PAUSE_KEY = 'mailPause';
/** How long reading stops after the provider says we ask too often; longer each time it happens again. */
const PAUSE_MINUTES = [10, 20, 40, 60];

export interface MailPause {
  until: Date;
  strikes: number;
  reason: string;
}

/** The pause reading is in, if any. For the job, and for the page that tells managers why nothing arrives. */
export async function getMailPause(db: Pick<Db, 'setting'>): Promise<MailPause | null> {
  const row = await db.setting.findUnique({ where: { key: PAUSE_KEY } });
  const v = (typeof row?.value === 'object' && row.value !== null ? row.value : {}) as { until?: unknown; strikes?: unknown; reason?: unknown };
  const until = typeof v.until === 'string' ? new Date(v.until) : null;
  if (!until || Number.isNaN(until.getTime())) return null;
  return { until, strikes: typeof v.strikes === 'number' ? v.strikes : 1, reason: typeof v.reason === 'string' ? v.reason : '' };
}

async function pause(db: Db, now: Date, reason: string): Promise<Date> {
  const before = await getMailPause(db);
  const strikes = (before?.strikes ?? 0) + 1;
  const until = new Date(now.getTime() + PAUSE_MINUTES[Math.min(strikes, PAUSE_MINUTES.length) - 1]! * 60_000);
  const value = { until: until.toISOString(), strikes, reason: reason.slice(0, 300) };
  await db.setting.upsert({ where: { key: PAUSE_KEY }, create: { key: PAUSE_KEY, value }, update: { value } });
  return until;
}

/** After this many rounds in a row in which a mailbox could not be read, its owner and the managers are told. */
const ALERT_AFTER_FAILURES = 30;

/**
 * Reads every connected mailbox in turn. A mailbox that fails is noted and does not hold up the
 * others; one whose permission was withdrawn is switched off and its owner is asked to connect
 * again. When the provider says we ask too often, everything stops for a while.
 */
export async function syncAllMailboxes(ctx: Ctx, apiFor: (account: EmailAccount) => MailApi, deps: MailDeps = {}): Promise<MailSyncSummary> {
  const summary: MailSyncSummary = { mailboxes: 0, stored: 0, failed: 0, removed: 0, pausedUntil: null };
  await withJobLock(ctx.db, 760601, async () => {
    const paused = await getMailPause(ctx.db);
    if (paused && paused.until > nowOf(ctx)) {
      summary.pausedUntil = paused.until;
      return true;
    }
    summary.removed = await removeOrphanedMailboxes(ctx, deps);
    const started = Date.now();
    const accounts = await ctx.db.emailAccount.findMany({ where: { needsReconnect: false }, orderBy: { lastSyncAt: { sort: 'asc', nulls: 'first' } } });
    let clean = true;
    for (const account of accounts) {
      if (Date.now() - started > ROUND_BUDGET_MS) break;
      summary.mailboxes++;
      const now = nowOf(ctx);
      try {
        const r = await syncMailbox(ctx, account.id, apiFor(account));
        summary.stored += r.stored;
        await ctx.db.emailAccount.update({ where: { id: account.id }, data: { lastSyncAt: now, lastOkAt: now, lastError: null, consecutiveFailures: 0 } });
      } catch (e) {
        summary.failed++;
        clean = false;
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof MailApiError && (e.throttled || e.setupFailed)) {
          // Not this mailbox's fault, and the next one would fare no better: wait.
          summary.pausedUntil = await pause(ctx.db, now, e.throttled ? `Zoho asked the CRM to slow down (${message})` : message);
          await ctx.db.emailAccount.update({ where: { id: account.id }, data: { lastSyncAt: now, lastError: message.slice(0, 500) } });
          if (e.setupFailed) console.error(`[mail] ${message}`);
          break;
        }
        const lost = e instanceof MailApiError && e.authFailed;
        const after = await ctx.db.emailAccount.update({ where: { id: account.id }, data: { lastSyncAt: now, lastError: message.slice(0, 500), consecutiveFailures: { increment: 1 }, needsReconnect: lost } });
        if (lost) {
          await notifyUsers(ctx.db, ctx, [account.userId], {
            type: 'mail.reconnect',
            title: 'Your mailbox needs to be connected again',
            body: `The CRM can no longer read ${account.address}. Customer e-mails are not reaching the timeline until you connect it again under your account.`,
            href: '/account/email',
          });
        } else if (after.consecutiveFailures >= ALERT_AFTER_FAILURES && (!after.alertedAt || now.getTime() - after.alertedAt.getTime() > DAY_MS)) {
          // Nobody is asked to connect again, because that would not help: but someone has to know.
          await ctx.db.emailAccount.update({ where: { id: account.id }, data: { alertedAt: now } });
          await notifyUsers(ctx.db, ctx, [account.userId, ...(await managerIds(ctx.db))], {
            type: 'mail.unreadable',
            title: `The CRM has not been able to read ${account.address} for a while`,
            body: `Customer e-mails from this mailbox are not reaching the timeline. What the mail service says: ${message.slice(0, 300)}`,
            href: '/account/email',
          });
        }
        if (!(e instanceof MailApiError)) console.error(`[mail] reading ${account.address} failed`, e);
      }
    }
    // A round without trouble ends the count of how often we were told to slow down.
    if (clean && paused) await ctx.db.setting.deleteMany({ where: { key: PAUSE_KEY } });
    return true;
  });
  return summary;
}
