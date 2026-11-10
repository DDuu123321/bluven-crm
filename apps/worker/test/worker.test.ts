import net from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyUsers, resetConfigCache, systemCtx } from '@bluven/core';
import { makeUser, resetDb, testDb } from '../../../packages/core/test/helpers';
import { sendNotificationEmails, setTransport } from '../src/mailer';
import { startScheduler } from '../src/scheduler';

const db = testDb();

describe('notification emails', () => {
  const sent: { to: unknown; subject?: string; text?: string }[] = [];
  let failNext = 0;

  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
    failNext = 0;
    process.env.APP_URL = 'https://crm.example.com';
    process.env.MAIL_FROM = 'Bluven CRM <crm@example.com>';
    resetConfigCache();
    const base = nodemailer.createTransport({ jsonTransport: true });
    setTransport({
      ...base,
      sendMail: async (mail: { to: unknown; subject?: string; text?: string }) => {
        if (failNext > 0) {
          failNext--;
          throw new Error('SMTP connection refused');
        }
        sent.push(mail);
        return {};
      },
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
  });
  afterEach(() => {
    setTransport(undefined);
    resetConfigCache();
  });

  const created = new Date('2026-11-10T01:00:00Z');
  const later = new Date('2026-11-10T01:05:00Z');
  const ctx = () => systemCtx(db, 'System', () => created);

  it('emails unread notifications after a short grace period, with a link back', async () => {
    const sam = await makeUser(['SALES'], 'Sam Sales');
    await notifyUsers(db, ctx(), [sam.id], { type: 'order.assigned', title: 'BLV-2026-00001 has been assigned to you', body: 'Jane Smith', href: '/orders/ord_1' });
    // Too fresh: the person may be looking at the app right now.
    expect(await sendNotificationEmails(db, new Date('2026-11-10T01:01:00Z'))).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(await sendNotificationEmails(db, later)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const note = await db.notification.findFirstOrThrow();
    expect(note.emailStatus).toBe('SENT');
    expect(sent[0]).toMatchObject({ to: { name: 'Sam Sales', address: sam.email }, subject: 'BLV-2026-00001 has been assigned to you' });
    expect(sent[0]!.text).toContain(`https://crm.example.com/notifications/${note.id}`);
    // Nothing is sent twice.
    expect(await sendNotificationEmails(db, later)).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });

  it('skips what was already read in the app and people who have left', async () => {
    const sam = await makeUser(['SALES']);
    const gone = await makeUser(['SALES']);
    await notifyUsers(db, ctx(), [sam.id, gone.id], { type: 't', title: 'Hello' });
    await db.notification.updateMany({ where: { userId: sam.id }, data: { readAt: created } });
    await db.user.update({ where: { id: gone.id }, data: { isActive: false } });
    expect(await sendNotificationEmails(db, later)).toEqual({ sent: 0, skipped: 2, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it('retries a failed send and gives up after five attempts', async () => {
    const sam = await makeUser(['SALES']);
    await notifyUsers(db, ctx(), [sam.id], { type: 't', title: 'Hello' });
    failNext = 1;
    expect(await sendNotificationEmails(db, later)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await db.notification.findFirstOrThrow()).toMatchObject({ emailStatus: 'PENDING', emailAttempts: 1, emailError: 'SMTP connection refused' });
    expect(await sendNotificationEmails(db, later)).toEqual({ sent: 1, skipped: 0, failed: 0 });

    await notifyUsers(db, ctx(), [sam.id], { type: 't', title: 'Never arrives' });
    failNext = 99;
    for (let i = 0; i < 5; i++) await sendNotificationEmails(db, later);
    expect(await db.notification.findFirstOrThrow({ where: { title: 'Never arrives' } })).toMatchObject({ emailStatus: 'FAILED', emailAttempts: 5 });
    expect(await sendNotificationEmails(db, later)).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });

  it('closes notifications out when no mail server is configured', async () => {
    setTransport(null);
    const sam = await makeUser(['SALES']);
    await notifyUsers(db, ctx(), [sam.id], { type: 't', title: 'Hello' });
    expect(await sendNotificationEmails(db, later)).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect((await db.notification.findFirstOrThrow()).emailStatus).toBe('SKIPPED');
  });
});

interface SmtpDelivery {
  user: string;
  pass: string;
  from: string;
  to: string[];
  data: string;
}

/** A mail server just capable enough to accept a message, so the real SMTP path gets exercised. */
function startSmtpServer(): Promise<{ port: number; deliveries: SmtpDelivery[]; close: () => Promise<void> }> {
  const deliveries: SmtpDelivery[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current: SmtpDelivery = { user: '', pass: '', from: '', to: [], data: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 test ESMTP');
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          deliveries.push(current);
          current = { user: current.user, pass: current.pass, from: '', to: [], data: '' };
          reply('250 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.toUpperCase();
        if (verb.startsWith('EHLO')) socket.write('250-test\r\n250-AUTH PLAIN\r\n250 OK\r\n');
        else if (verb.startsWith('AUTH PLAIN')) {
          const [, user = '', pass = ''] = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString('utf8').split('\0');
          current.user = user;
          current.pass = pass;
          reply('235 authenticated');
        } else if (verb.startsWith('MAIL FROM:')) {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          reply('250 ok');
        } else if (verb.startsWith('RCPT TO:')) {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ port, deliveries, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

describe('notification emails over SMTP', () => {
  const saved = { SMTP_URL: process.env.SMTP_URL, MAIL_FROM: process.env.MAIL_FROM, APP_URL: process.env.APP_URL };

  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setTransport(undefined);
    resetConfigCache();
  });

  it('signs in with the account from SMTP_URL and delivers a readable message', async () => {
    const smtp = await startSmtpServer();
    try {
      // The address is written the way the deployment guide says: "@" as "%40".
      process.env.SMTP_URL = `smtp://crm%40example.com.au:app-pass%2Fword@127.0.0.1:${smtp.port}`;
      process.env.MAIL_FROM = 'Bluven CRM <crm@example.com.au>';
      process.env.APP_URL = 'https://crm.example.com.au';
      resetConfigCache();
      setTransport(undefined);

      const created = new Date('2026-11-10T01:00:00Z');
      const sam = await makeUser(['SALES'], 'Sam Sales');
      await notifyUsers(db, systemCtx(db, 'System', () => created), [sam.id], {
        type: 'handoff.returned',
        title: 'BLV-2026-00007 was returned by operations',
        body: 'Meter box photo is blurry <retake it>.\nSecond line.',
        href: '/orders/ord_7',
      });
      expect(await sendNotificationEmails(db, new Date('2026-11-10T01:05:00Z'))).toEqual({ sent: 1, skipped: 0, failed: 0 });

      expect(smtp.deliveries).toHaveLength(1);
      const mail = smtp.deliveries[0]!;
      expect(mail).toMatchObject({ user: 'crm@example.com.au', pass: 'app-pass/word', from: 'crm@example.com.au', to: [sam.email] });
      expect(mail.data).toContain('From: Bluven CRM <crm@example.com.au>');
      expect(mail.data).toContain(`To: Sam Sales <${sam.email}>`);
      expect(mail.data).toContain('Subject: BLV-2026-00007 was returned by operations');
      const note = await db.notification.findFirstOrThrow();
      expect(note.emailStatus).toBe('SENT');
      // Both the plain-text and the HTML part carry the link; the HTML part escapes the body.
      const decoded = mail.data.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      expect(decoded).toContain(`Open in Bluven CRM: https://crm.example.com.au/notifications/${note.id}`);
      expect(decoded).toContain('Meter box photo is blurry &lt;retake it&gt;.');
      expect(decoded).toContain(`<a href="https://crm.example.com.au/notifications/${note.id}">Open in Bluven CRM</a>`);
    } finally {
      await smtp.close();
    }
  });

  it('keeps the notification for a later try when the mail server is unreachable', async () => {
    const smtp = await startSmtpServer();
    const port = smtp.port;
    await smtp.close(); // nothing listens on this port any more
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
    resetConfigCache();
    setTransport(undefined);
    const sam = await makeUser(['SALES']);
    await notifyUsers(db, systemCtx(db, 'System', () => new Date('2026-11-10T01:00:00Z')), [sam.id], { type: 't', title: 'Hello' });
    expect(await sendNotificationEmails(db, new Date('2026-11-10T01:05:00Z'))).toEqual({ sent: 0, skipped: 0, failed: 1 });
    const note = await db.notification.findFirstOrThrow();
    expect(note).toMatchObject({ emailStatus: 'PENDING', emailAttempts: 1 });
    expect(note.emailError).toMatch(/ECONNREFUSED|connect/i);
  });
});

describe('scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs jobs on their interval, never overlapping, and survives failures', async () => {
    const log: string[] = [];
    let slowRuns = 0;
    let release!: () => void;
    let failing = 0;
    const scheduler = startScheduler(
      [
        { name: 'slow', everyMs: 1_000, run: () => new Promise<string>((resolve) => { slowRuns++; release = () => resolve('done'); }) },
        { name: 'broken', everyMs: 1_000, run: async () => { failing++; throw new Error('boom'); } },
      ],
      (line) => log.push(line),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await vi.advanceTimersByTimeAsync(5_000);
    // The slow job is still on its first run; its later turns were skipped rather than stacked up.
    expect(slowRuns).toBe(1);
    // The broken job keeps being tried and never takes the loop down.
    expect(failing).toBeGreaterThanOrEqual(4);
    expect(errors).toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slowRuns).toBe(2);
    expect(log.some((l) => l.includes('slow: done'))).toBe(true);

    release();
    await scheduler.stop();
    const runsAtStop = slowRuns;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(slowRuns).toBe(runsAtStop);
    errors.mockRestore();
  });
});
