// Notification emails. Every in-app notification is also offered by email; whether it is sent
// depends on SMTP being configured and on the person not having read it in the app already.
import nodemailer, { type Transporter } from 'nodemailer';
import type { Db } from '@bluven/db';
import { getConfig, withJobLock } from '@bluven/core';

const MAX_ATTEMPTS = 5;
/** Give the person a moment to see it in the app before an email goes out. */
const GRACE_MS = 2 * 60_000;

let transport: Transporter | null | undefined;

function getTransport(): Transporter | null {
  if (transport !== undefined) return transport;
  const { smtpUrl } = getConfig();
  transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;
  return transport;
}

/** For tests. */
export function setTransport(next: Transporter | null | undefined): void {
  transport = next;
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
    const mailer = getTransport();
    if (!mailer) {
      // No mail server: close the notifications out so they do not queue up forever.
      const { count } = await db.notification.updateMany({ where: { emailStatus: 'PENDING' }, data: { emailStatus: 'SKIPPED' } });
      result.skipped = count;
      return true;
    }
    const config = getConfig();
    const due = await db.notification.findMany({
      where: { emailStatus: 'PENDING', createdAt: { lte: new Date(now.getTime() - GRACE_MS) } },
      include: { user: { select: { email: true, name: true, isActive: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    for (const n of due) {
      if (n.readAt || !n.user.isActive) {
        await db.notification.update({ where: { id: n.id }, data: { emailStatus: 'SKIPPED' } });
        result.skipped++;
        continue;
      }
      const link = n.href ? `${config.appUrl}/notifications/${n.id}` : `${config.appUrl}/notifications`;
      try {
        await mailer.sendMail({
          from: config.mailFrom,
          to: { name: n.user.name, address: n.user.email },
          subject: n.title,
          text: `${n.title}\n\n${n.body ? `${n.body}\n\n` : ''}Open in Bluven CRM: ${link}\n`,
          html: `<p><strong>${escapeHtml(n.title)}</strong></p>${n.body ? `<p style="white-space:pre-wrap">${escapeHtml(n.body)}</p>` : ''}<p><a href="${escapeHtml(link)}">Open in Bluven CRM</a></p>`,
        });
        await db.notification.update({ where: { id: n.id }, data: { emailStatus: 'SENT', emailAttempts: n.emailAttempts + 1, emailError: null } });
        result.sent++;
      } catch (e) {
        const attempts = n.emailAttempts + 1;
        await db.notification.update({
          where: { id: n.id },
          data: { emailAttempts: attempts, emailError: (e instanceof Error ? e.message : String(e)).slice(0, 500), emailStatus: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING' },
        });
        result.failed++;
      }
    }
    return true;
  });
  return result;
}
