// Sending the e-mails the CRM writes to customers by itself: the welcome, the dates of the
// installation, the thank-you that asks for the balance. They are queued by the steps
// operations takes; this sends them through the operations mailbox and files what was sent on
// the order, like any other e-mail.
import type { CustomerNotice, EmailAccount } from '@bluven/db';
import {
  NOTICE_KIND_LABEL,
  addActivity,
  fullName,
  getOperationsSettings,
  inTx,
  newId,
  notifyRoles,
  notifyUsers,
  nowOf,
  systemCtx,
  textToHtml,
  withJobLock,
  type Ctx,
  type NoticeKind,
} from '@bluven/core';
import { MailApiError, type MailApi } from '../zoho/client';
import { mailApiFor, type MailDeps } from './accounts';
import { getMailPause } from './sync';

export interface NoticeRun {
  sent: number;
  /** Tried and not sent this time; they are tried again later. */
  waiting: number;
  /** Given up on, or impossible to send. Operations is told and can send them again. */
  stopped: number;
}

const LOCK_KEY = 760602;
/** How long to wait before each further try, when the mail service could not be reached. After the last one the e-mail is given up on. */
const RETRY_MINUTES = [5, 30, 180];

/** The mailbox these e-mails go out from: the one chosen in the settings, otherwise that of whoever took the step. */
async function mailboxFor(ctx: Ctx, notice: CustomerNotice): Promise<EmailAccount | null> {
  const settings = await getOperationsSettings(ctx.db);
  for (const userId of [settings.mailboxUserId, notice.createdById]) {
    if (!userId) continue;
    const mailbox = await ctx.db.emailAccount.findUnique({ where: { userId } });
    if (mailbox && !mailbox.needsReconnect) return mailbox;
  }
  return null;
}

/** Stops trying to send a notice and tells the people who can put it right. */
async function stop(ctx: Ctx, notice: CustomerNotice & { order: { orderNo: string } }, status: 'FAILED' | 'SKIPPED', note: string): Promise<void> {
  await ctx.db.customerNotice.update({ where: { id: notice.id }, data: { status, nextAttemptAt: null, note: note.slice(0, 500) } });
  const what = NOTICE_KIND_LABEL[notice.kind as NoticeKind] ?? notice.kind;
  const news = { type: 'mail.notice_failed', title: `${notice.order.orderNo}: the “${what}” e-mail to the customer was not sent`, body: note, href: `/ops/orders/${notice.orderId}`, orderId: notice.orderId };
  // Whoever took the step, and failing that everyone in operations.
  if (notice.createdById) await notifyUsers(ctx.db, ctx, [notice.createdById], news);
  else await notifyRoles(ctx.db, ctx, ['OPS'], news);
}

/**
 * Sends the notices that are due. One that cannot be sent for a passing reason is tried again
 * three times, further apart each time. One that cannot be sent at all (no mailbox, the order
 * was cancelled) is set aside with the reason, for operations to send again once it is put right.
 * Returns null when another process is already at it.
 */
export async function sendCustomerNotices(base: Ctx, deps: MailDeps = {}, limit = 20): Promise<NoticeRun | null> {
  const ctx = base.actor.kind === 'system' ? base : systemCtx(base.db, 'Operations e-mail', base.now);
  return withJobLock(ctx.db, LOCK_KEY, async () => {
    const run: NoticeRun = { sent: 0, waiting: 0, stopped: 0 };
    // While reading mail is paused because the provider asked us to slow down, sending waits too.
    const paused = await getMailPause(ctx.db);
    if (paused && paused.until > nowOf(ctx)) return run;
    const due = await ctx.db.customerNotice.findMany({
      where: { status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: nowOf(ctx) } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { order: { select: { orderNo: true, customerId: true, sideState: true, customer: { select: { firstName: true, lastName: true } } } } },
      take: limit,
    });
    for (const notice of due) {
      if (notice.order.sideState === 'CANCELLED' || notice.order.sideState === 'LOST') {
        await ctx.db.customerNotice.update({ where: { id: notice.id }, data: { status: 'SKIPPED', nextAttemptAt: null, note: 'The order was closed before this went out.' } });
        run.stopped++;
        continue;
      }
      const mailbox = await mailboxFor(ctx, notice);
      if (!mailbox) {
        await stop(ctx, notice, 'SKIPPED', 'There is no mailbox to send it from. Connect the operations mailbox (under your account, then choose it in the settings for operations), and send the e-mail again from the order.');
        run.stopped++;
        continue;
      }
      const api: MailApi = deps.apiFor ? deps.apiFor(mailbox) : mailApiFor(ctx.db, mailbox, deps);
      const html = textToHtml(notice.body);
      let sent: { messageId: string | null; messageIdHeader?: string | null };
      try {
        sent = await api.send(mailbox.providerAccountId, { from: mailbox.address, to: [notice.toAddress], cc: [], subject: notice.subject, html, attachments: [] });
      } catch (e) {
        if (!(e instanceof MailApiError)) throw e;
        if (e.authFailed) {
          await ctx.db.emailAccount.update({ where: { id: mailbox.id }, data: { needsReconnect: true, lastError: e.message.slice(0, 500) } });
          await stop(ctx, notice, 'SKIPPED', `Zoho no longer accepts the CRM’s access to ${mailbox.address}. Connect that mailbox again, then send the e-mail again from the order.`);
          run.stopped++;
        } else if (e.retryable && notice.attempts < RETRY_MINUTES.length) {
          const wait = RETRY_MINUTES[notice.attempts]!;
          await ctx.db.customerNotice.update({ where: { id: notice.id }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(nowOf(ctx).getTime() + wait * 60_000), note: `The mail service could not be reached. Trying again in ${wait} minutes.` } });
          run.waiting++;
        } else {
          await stop(ctx, notice, 'FAILED', e.retryable ? 'The mail service could not be reached, four times in a row.' : `The mail service did not take the message: ${e.message}`);
          run.stopped++;
        }
        continue;
      }

      // From here on the customer has the message. It is filed on the order like one a person wrote.
      const now = nowOf(ctx);
      await inTx(ctx.db, async (tx) => {
        const emailId = newId('eml');
        const header = sent.messageIdHeader && !(await tx.emailMessage.findUnique({ where: { messageIdHeader: sent.messageIdHeader }, select: { id: true } })) ? sent.messageIdHeader : null;
        const activityId = await addActivity(tx, ctx, {
          customerId: notice.order.customerId,
          orderId: notice.orderId,
          type: 'EMAIL_OUT',
          summary: `Email to ${fullName(notice.order.customer)}: ${notice.subject}`,
          body: notice.body.slice(0, 4000),
          occurredAt: now,
          payload: { emailId, noticeId: notice.id, kind: notice.kind },
        });
        await tx.emailMessage.create({
          data: {
            id: emailId,
            accountId: mailbox.id,
            customerId: notice.order.customerId,
            orderId: notice.orderId,
            direction: 'OUT',
            providerMessageId: sent.messageId,
            providerThreadId: sent.messageId,
            messageIdHeader: header,
            fromAddress: mailbox.address,
            fromName: mailbox.displayName || 'Bluven Operations',
            toAddresses: [notice.toAddress],
            ccAddresses: [],
            subject: notice.subject,
            bodyText: notice.body,
            bodyHtml: html,
            sentAt: now,
            // Nobody wrote it: it went out because of a step somebody took.
            sentById: null,
            activityId,
            createdAt: now,
          },
        });
        await tx.customerNotice.update({ where: { id: notice.id }, data: { status: 'SENT', sentAt: now, nextAttemptAt: null, note: '', emailMessageId: emailId, attempts: { increment: 1 } } });
      });
      run.sent++;
    }
    return run;
  });
}

/**
 * For a server on which customer e-mail is not set up at all: the notices that are waiting are
 * set aside with the reason, so that operations sees on the order that nothing went out and
 * writes to the customer themselves. Sending them again later is possible once e-mail is set up.
 */
export async function setAsideCustomerNotices(base: Ctx): Promise<number> {
  const { count } = await base.db.customerNotice.updateMany({
    where: { status: 'PENDING' },
    data: { status: 'SKIPPED', nextAttemptAt: null, note: 'Customer e-mail is not set up on this server, so this was not sent. Write to the customer yourself, or send it again from here once an administrator has set e-mail up.' },
  });
  return count;
}
