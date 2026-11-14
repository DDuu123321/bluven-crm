// Notification emails. Every in-app notification is also offered by email; whether it is sent
// depends on a way to send being configured and on the person not having read it in the app already.
//
// Two ways to send, chosen by configuration:
//   MAIL_RELAY_URL + MAIL_RELAY_KEY   hand the message to an HTTPS relay (the Bluven website runs
//                                     one at /api/send-mail). For hosts that block outgoing SMTP.
//   SMTP_URL                          talk to the mail server directly.
import nodemailer, { type Transporter } from 'nodemailer';
import type { Db, Prisma } from '@bluven/db';
import { NOTIFICATION_KINDS, NOTIFICATION_KIND_LABEL, getConfig, localDateTimeInput, notificationKind, parseDateOnly, withJobLock, type NotificationKind } from '@bluven/core';

/** Give the person a moment to see it in the app before an email goes out. */
const GRACE_MS = 2 * 60_000;
/**
 * How long to wait after each failed attempt before the next one. A mail server that is down for
 * an afternoon must not cost anyone their notifications, so the attempts are spread over a day
 * before a message is given up on.
 */
const RETRY_AFTER_MS = [2, 10, 30, 2 * 60, 6 * 60, 12 * 60].map((minutes) => minutes * 60_000);
const MAX_ATTEMPTS = RETRY_AFTER_MS.length + 1;
const RELAY_TIMEOUT_MS = 25_000;

interface OutgoingMail {
  to: { name: string; address: string };
  subject: string;
  text: string;
  html: string;
}

/** Something that can deliver one message. Rejects when it could not. */
export type MailSender = (mail: OutgoingMail) => Promise<void>;

let sender: MailSender | null | undefined;

function relaySender(url: string, key: string): MailSender {
  return async (mail) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-key': key },
      // The relay decides who the mail is from; a caller cannot choose the sender.
      body: JSON.stringify({ to: mail.to.address, subject: mail.subject, html: mail.html }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`mail relay answered ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
  };
}

function smtpSender(transport: Transporter, from: string): MailSender {
  return async (mail) => {
    await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  };
}

function getSender(): MailSender | null {
  if (sender !== undefined) return sender;
  const { smtpUrl, mailFrom, mailRelay } = getConfig();
  if (mailRelay.url && mailRelay.key) sender = relaySender(mailRelay.url, mailRelay.key);
  // Short timeouts: a host that silently drops SMTP must not pin the job for minutes per message.
  else if (smtpUrl) sender = smtpSender(nodemailer.createTransport({ url: smtpUrl, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 }), mailFrom);
  else sender = null;
  return sender;
}

/** For tests: a fixed sender, null for "no way to send", undefined to read the configuration again. */
export function setMailSender(next: MailSender | null | undefined): void {
  sender = next;
}

/** How notification emails go out, for the start-up log. */
export function describeMailSetup(): string {
  const { smtpUrl, mailRelay } = getConfig();
  if (mailRelay.url && mailRelay.key) return `on, through the relay at ${new URL(mailRelay.url).host}`;
  if (smtpUrl) return 'on, by SMTP';
  return 'off (neither MAIL_RELAY_URL nor SMTP_URL is set)';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface MailRunResult {
  sent: number;
  skipped: number;
  failed: number;
}

/** Sends the emails that are due. Safe to run from several workers: only one runs at a time. */
export async function sendNotificationEmails(db: Db, now: Date = new Date()): Promise<MailRunResult> {
  const result: MailRunResult = { sent: 0, skipped: 0, failed: 0 };
  await withJobLock(db, 760301, async () => {
    const send = getSender();
    if (!send) {
      // No way to send: close the notifications out so they do not queue up forever.
      const { count } = await db.notification.updateMany({ where: { emailStatus: 'PENDING' }, data: { emailStatus: 'SKIPPED' } });
      result.skipped = count;
      return true;
    }
    const config = getConfig();
    // A message that failed before waits its turn; the wait grows with every failure. The wait is
    // part of the question put to the database: a message that is waiting must not take the
    // place of one that is due, or an afternoon's worth of failures holds up everything after it.
    const waitedLongEnough: Prisma.NotificationWhereInput[] = RETRY_AFTER_MS.map((wait, i) => ({
      emailAttempts: i === RETRY_AFTER_MS.length - 1 ? { gte: i + 1 } : i + 1,
      emailLastAttemptAt: { lte: new Date(now.getTime() - wait) },
    }));
    const due = await db.notification.findMany({
      where: {
        emailStatus: 'PENDING',
        createdAt: { lte: new Date(now.getTime() - GRACE_MS) },
        // People who chose a daily summary get theirs in one e-mail each morning instead.
        user: { dailySummary: false },
        OR: [{ emailLastAttemptAt: null }, ...waitedLongEnough],
      },
      include: { user: { select: { email: true, name: true, isActive: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    for (const n of due) {
      if (n.readAt || !n.user.isActive) {
        await db.notification.update({ where: { id: n.id }, data: { emailStatus: 'SKIPPED' } });
        result.skipped++;
        continue;
      }
      const link = n.href ? `${config.appUrl}/notifications/${n.id}` : `${config.appUrl}/notifications`;
      const attempts = n.emailAttempts + 1;
      try {
        await send({
          to: { name: n.user.name, address: n.user.email },
          subject: n.title,
          text: `${n.title}\n\n${n.body ? `${n.body}\n\n` : ''}Open in Bluven CRM: ${link}\n`,
          html: `<p><strong>${escapeHtml(n.title)}</strong></p>${n.body ? `<p style="white-space:pre-wrap">${escapeHtml(n.body)}</p>` : ''}<p><a href="${escapeHtml(link)}">Open in Bluven CRM</a></p>`,
        });
        await db.notification.update({ where: { id: n.id }, data: { emailStatus: 'SENT', emailAttempts: attempts, emailLastAttemptAt: now, emailError: null } });
        result.sent++;
      } catch (e) {
        await db.notification.update({
          where: { id: n.id },
          data: { emailAttempts: attempts, emailLastAttemptAt: now, emailError: (e instanceof Error ? e.message : String(e)).slice(0, 500), emailStatus: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING' },
        });
        result.failed++;
      }
    }
    return true;
  });
  return result;
}

// ---------------------------------------------------------------------------
// The daily summary
// ---------------------------------------------------------------------------

/** From this hour of the business day the day's summary goes out. */
const SUMMARY_HOUR = 7;

export interface SummaryRunResult {
  /** People who were sent their summary. */
  sent: number;
  /** People with nothing unread to tell them about: no e-mail, and the day counts as dealt with. */
  nothingToSay: number;
  failed: number;
}

/**
 * Sends each person who chose a daily summary one e-mail with everything that is still unread,
 * once per business day and not before seven in the morning. A summary that could not be sent is
 * tried again at the next run; nothing is marked as sent until it has gone out.
 */
export async function sendDailySummaries(db: Db, now: Date = new Date()): Promise<SummaryRunResult> {
  const result: SummaryRunResult = { sent: 0, nothingToSay: 0, failed: 0 };
  await withJobLock(db, 760302, async () => {
    const send = getSender();
    if (!send) return true;
    const config = getConfig();
    const local = localDateTimeInput(now, config.timeZone);
    if (Number(local.slice(11, 13)) < SUMMARY_HOUR) return true;
    const today = parseDateOnly(local.slice(0, 10))!;
    const people = await db.user.findMany({
      where: { isActive: true, dailySummary: true, OR: [{ dailySummaryOn: null }, { dailySummaryOn: { lt: today } }] },
      select: { id: true, name: true, email: true },
      orderBy: { id: 'asc' },
    });
    for (const person of people) {
      const waiting = await db.notification.findMany({ where: { userId: person.id, emailStatus: 'PENDING', createdAt: { lte: now } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 });
      const unread = waiting.filter((n) => !n.readAt);
      const read = waiting.filter((n) => n.readAt).map((n) => n.id);
      if (unread.length === 0) {
        await db.$transaction([db.notification.updateMany({ where: { id: { in: read } }, data: { emailStatus: 'SKIPPED' } }), db.user.update({ where: { id: person.id }, data: { dailySummaryOn: today } })]);
        result.nothingToSay++;
        continue;
      }
      const groups = new Map<NotificationKind, typeof unread>();
      for (const n of unread) groups.set(notificationKind(n.type), [...(groups.get(notificationKind(n.type)) ?? []), n]);
      const kinds = NOTIFICATION_KINDS.filter((k) => groups.has(k));
      const link = (n: (typeof unread)[number]) => (n.href ? `${config.appUrl}/notifications/${n.id}` : `${config.appUrl}/notifications`);
      const count = `${unread.length} notification${unread.length === 1 ? ' is' : 's are'} waiting for you in Bluven CRM`;
      const firstName = person.name.split(/\s+/)[0] ?? person.name;
      const footer = 'You get this once a day because you chose a daily summary. You can change that on the Notifications page.';
      try {
        await send({
          to: { name: person.name, address: person.email },
          subject: `Bluven CRM: ${unread.length} notification${unread.length === 1 ? '' : 's'} waiting for you`,
          text: `Good morning ${firstName},\n\n${count}.\n\n${kinds.map((k) => `${NOTIFICATION_KIND_LABEL[k]}\n${groups.get(k)!.map((n) => `- ${n.title}\n  ${link(n)}`).join('\n')}`).join('\n\n')}\n\nAll of them: ${config.appUrl}/notifications\n\n${footer}\n`,
          html: `<p>Good morning ${escapeHtml(firstName)},</p><p>${escapeHtml(count)}.</p>${kinds
            .map((k) => `<p style="margin-bottom:4px"><strong>${escapeHtml(NOTIFICATION_KIND_LABEL[k])}</strong></p><ul style="margin-top:0">${groups.get(k)!.map((n) => `<li><a href="${escapeHtml(link(n))}">${escapeHtml(n.title)}</a></li>`).join('')}</ul>`)
            .join('')}<p><a href="${escapeHtml(`${config.appUrl}/notifications`)}">Open all of them in Bluven CRM</a></p><p style="color:#64748b;font-size:12px">${escapeHtml(footer)}</p>`,
        });
        await db.$transaction([
          db.notification.updateMany({ where: { id: { in: unread.map((n) => n.id) } }, data: { emailStatus: 'SENT', summarisedAt: now, emailLastAttemptAt: now } }),
          db.notification.updateMany({ where: { id: { in: read } }, data: { emailStatus: 'SKIPPED' } }),
          db.user.update({ where: { id: person.id }, data: { dailySummaryOn: today } }),
        ]);
        result.sent++;
      } catch (e) {
        console.error(`[${now.toISOString()}] daily summary for ${person.id} could not be sent`, e instanceof Error ? e.message : e);
        result.failed++;
      }
    }
    return true;
  });
  return result;
}
