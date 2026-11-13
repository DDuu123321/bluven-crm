import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyUsers, resetConfigCache, setDailySummary, systemCtx } from '@bluven/core';
import { as, makeUser, resetDb, testDb } from '../../../packages/core/test/helpers';
import { sendDailySummaries, sendNotificationEmails, setMailSender } from '../src/mailer';
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
    setMailSender(async (mail) => {
      if (failNext > 0) {
        failNext--;
        throw new Error('SMTP connection refused');
      }
      sent.push(mail);
    });
  });
  afterEach(() => {
    setMailSender(undefined);
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

  it('retries a failed send after growing pauses and gives up after about a day', async () => {
    const sam = await makeUser(['SALES']);
    const after = (minutes: number) => new Date(later.getTime() + minutes * 60_000);
    const pending = (title: string) => db.notification.findFirstOrThrow({ where: { title } });
    await notifyUsers(db, ctx(), [sam.id], { type: 't', title: 'Hello' });
    failNext = 1;
    expect(await sendNotificationEmails(db, later)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await pending('Hello')).toMatchObject({ emailStatus: 'PENDING', emailAttempts: 1, emailError: 'SMTP connection refused' });
    // Not hammered: a minute later nothing is tried, two minutes after the failure it goes out.
    expect(await sendNotificationEmails(db, after(1))).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(await sendNotificationEmails(db, after(2))).toEqual({ sent: 1, skipped: 0, failed: 0 });

    // A mail server that is down for hours. Attempts fall at 0, 2, 12, 42 and 162 minutes…
    await notifyUsers(db, systemCtx(db, 'System', () => new Date(later.getTime() - 5 * 60_000)), [sam.id], { type: 't', title: 'Outage' });
    failNext = 999;
    const tried: number[] = [];
    for (const minute of [0, 1, 2, 11, 12, 41, 42, 161, 162, 300, 521]) {
      if ((await sendNotificationEmails(db, after(minute))).failed) tried.push(minute);
    }
    expect(tried).toEqual([0, 2, 12, 42, 162]);
    expect(await pending('Outage')).toMatchObject({ emailStatus: 'PENDING', emailAttempts: 5 });
    // …and when it is back the message still goes out, hours later.
    failNext = 0;
    expect(await sendNotificationEmails(db, after(522))).toEqual({ sent: 1, skipped: 0, failed: 0 });

    // Only after seven attempts spread over about a day is a message given up on.
    await notifyUsers(db, systemCtx(db, 'System', () => new Date(later.getTime() - 5 * 60_000)), [sam.id], { type: 't', title: 'Never arrives' });
    failNext = 999;
    for (const minute of [0, 2, 12, 42, 162, 522, 1242]) await sendNotificationEmails(db, after(minute));
    expect(await pending('Never arrives')).toMatchObject({ emailStatus: 'FAILED', emailAttempts: 7 });
    expect(await sendNotificationEmails(db, after(5000))).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });

  it('closes notifications out when no mail server is configured', async () => {
    setMailSender(null);
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

describe('the daily summary', () => {
  const sent: { to: { address: string }; subject: string; text: string; html: string }[] = [];
  let failNext = 0;

  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
    failNext = 0;
    process.env.APP_URL = 'https://crm.example.com';
    process.env.APP_TIMEZONE = 'Australia/Sydney';
    resetConfigCache();
    setMailSender(async (mail) => {
      if (failNext > 0) {
        failNext--;
        throw new Error('SMTP connection refused');
      }
      sent.push(mail);
    });
  });
  afterEach(() => {
    setMailSender(undefined);
    resetConfigCache();
  });

  // Sydney is eleven hours ahead of UTC in November: noon on the 10th, and the next morning.
  const noon = new Date('2026-11-10T01:00:00Z');
  const beforeSeven = new Date('2026-11-10T19:30:00Z');
  const afterSeven = new Date('2026-11-10T20:05:00Z');
  const nextMorning = new Date('2026-11-11T20:05:00Z');
  const at = (when: Date) => systemCtx(db, 'System', () => when);

  it('goes out once a morning with everything still unread, in place of an e-mail for each notification', async () => {
    const sam = await makeUser(['SALES'], 'Sam Sales');
    const alex = await makeUser(['SALES'], 'Alex Sales');
    await setDailySummary(as(sam), true);
    await notifyUsers(db, at(noon), [sam.id, alex.id], { type: 'order.assigned', title: 'BLV-2026-00001 has been assigned to you', href: '/orders/ord_1' });
    await notifyUsers(db, at(noon), [sam.id], { type: 'task.due', title: 'Task due: call Jane back' });
    await notifyUsers(db, at(noon), [sam.id], { type: 'handoff.returned', title: 'Read already', href: '/orders/ord_2' });
    await db.notification.updateMany({ where: { title: 'Read already' }, data: { readAt: noon } });

    // Alex gets his e-mail as before; Sam's wait for the morning.
    expect(await sendNotificationEmails(db, new Date(noon.getTime() + 5 * 60_000))).toMatchObject({ sent: 1 });
    expect(sent.map((m) => m.to.address)).toEqual([alex.email]);
    expect(await sendDailySummaries(db, beforeSeven)).toEqual({ sent: 0, nothingToSay: 0, failed: 0 });

    expect(await sendDailySummaries(db, afterSeven)).toEqual({ sent: 1, nothingToSay: 0, failed: 0 });
    const summary = sent[1]!;
    expect(summary.to.address).toBe(sam.email);
    expect(summary.subject).toBe('Bluven CRM: 2 notifications waiting for you');
    expect(summary.text).toContain('Good morning Sam,');
    expect(summary.text).toContain('Leads & assignments\n- BLV-2026-00001 has been assigned to you');
    expect(summary.text).toContain('Tasks\n- Task due: call Jane back\n  https://crm.example.com/notifications');
    expect(summary.text).not.toContain('Read already');
    expect(summary.html).toContain('<strong>Tasks</strong>');
    const notes = await db.notification.findMany({ where: { userId: sam.id }, orderBy: { title: 'asc' } });
    expect(notes.map((n) => [n.title, n.emailStatus, !!n.summarisedAt])).toEqual([
      ['BLV-2026-00001 has been assigned to you', 'SENT', true],
      ['Read already', 'SKIPPED', false],
      ['Task due: call Jane back', 'SENT', true],
    ]);

    // Once a day: what arrives later the same day waits for the next morning.
    await notifyUsers(db, at(afterSeven), [sam.id], { type: 'deposit.confirmed', title: 'Deposit confirmed' });
    expect(await sendDailySummaries(db, new Date(afterSeven.getTime() + 3 * 3_600_000))).toEqual({ sent: 0, nothingToSay: 0, failed: 0 });
    expect(await sendNotificationEmails(db, new Date(afterSeven.getTime() + 3 * 3_600_000))).toMatchObject({ sent: 0 });
    expect(await sendDailySummaries(db, nextMorning)).toEqual({ sent: 1, nothingToSay: 0, failed: 0 });
    expect(sent[2]).toMatchObject({ subject: 'Bluven CRM: 1 notification waiting for you' });
    expect(sent[2]!.text).toContain('Deposits\n- Deposit confirmed');
  });

  it('sends nothing when there is nothing unread, and tries again when sending fails', async () => {
    const sam = await makeUser(['SALES'], 'Sam Sales');
    await setDailySummary(as(sam), true);
    expect(await sendDailySummaries(db, afterSeven)).toEqual({ sent: 0, nothingToSay: 1, failed: 0 });
    expect(await sendDailySummaries(db, afterSeven)).toEqual({ sent: 0, nothingToSay: 0, failed: 0 });
    expect(sent).toHaveLength(0);

    await notifyUsers(db, at(afterSeven), [sam.id], { type: 'task.due', title: 'Task due: send the quote' });
    failNext = 1;
    expect(await sendDailySummaries(db, nextMorning)).toEqual({ sent: 0, nothingToSay: 0, failed: 1 });
    expect((await db.notification.findFirstOrThrow({ where: { userId: sam.id } })).emailStatus).toBe('PENDING');
    expect(await sendDailySummaries(db, new Date(nextMorning.getTime() + 10 * 60_000))).toEqual({ sent: 1, nothingToSay: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    // People who have left get nothing.
    await db.user.update({ where: { id: sam.id }, data: { isActive: false } });
    await notifyUsers(db, at(nextMorning), [sam.id], { type: 'task.due', title: 'Too late' });
    expect(await sendDailySummaries(db, new Date(nextMorning.getTime() + 2 * 86_400_000))).toEqual({ sent: 0, nothingToSay: 0, failed: 0 });
  });
});

describe('notification emails through the website relay', () => {
  const saved = { MAIL_RELAY_URL: process.env.MAIL_RELAY_URL, MAIL_RELAY_KEY: process.env.MAIL_RELAY_KEY, SMTP_URL: process.env.SMTP_URL, APP_URL: process.env.APP_URL };
  let relay: http.Server;
  let received: { key: string | undefined; body: Record<string, unknown> }[];
  let answer = 200;

  beforeEach(async () => {
    await resetDb();
    received = [];
    answer = 200;
    // Answers like the website's /api/send-mail: shared key in a header, one recipient, HTML body.
    relay = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        received.push({ key: req.headers['x-relay-key'] as string | undefined, body: JSON.parse(raw) as Record<string, unknown> });
        res.writeHead(answer, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer === 200 ? { ok: true } : { error: 'unauthorized' }));
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => resolve()));
    process.env.MAIL_RELAY_URL = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}/api/send-mail`;
    process.env.MAIL_RELAY_KEY = 'relay-key-for-tests';
    // The relay wins over SMTP when both are set: on a host that blocks SMTP the direct route cannot work.
    process.env.SMTP_URL = 'smtp://127.0.0.1:1';
    process.env.APP_URL = 'https://crm.bluven.com.au';
    resetConfigCache();
    setMailSender(undefined);
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setMailSender(undefined);
    resetConfigCache();
  });

  it('hands the message to the relay with the shared key, and records a refusal as a failed attempt', async () => {
    const created = new Date('2026-11-10T01:00:00Z');
    const sam = await makeUser(['SALES'], 'Sam Sales');
    await notifyUsers(db, systemCtx(db, 'System', () => created), [sam.id], { type: 'order.assigned', title: 'BLV-2026-00009 has been assigned to you', body: 'Jane <Smith>', href: '/orders/ord_9' });
    expect(await sendNotificationEmails(db, new Date('2026-11-10T01:05:00Z'))).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const note = await db.notification.findFirstOrThrow();
    expect(received).toHaveLength(1);
    expect(received[0]!.key).toBe('relay-key-for-tests');
    expect(received[0]!.body).toMatchObject({ to: sam.email, subject: 'BLV-2026-00009 has been assigned to you' });
    expect(received[0]!.body).not.toHaveProperty('from'); // the relay decides the sender
    expect(received[0]!.body.html).toContain('Jane &lt;Smith&gt;');
    expect(received[0]!.body.html).toContain(`https://crm.bluven.com.au/notifications/${note.id}`);

    answer = 401;
    await notifyUsers(db, systemCtx(db, 'System', () => created), [sam.id], { type: 't', title: 'Second' });
    expect(await sendNotificationEmails(db, new Date('2026-11-10T01:06:00Z'))).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect((await db.notification.findFirstOrThrow({ where: { title: 'Second' } })).emailError).toContain('mail relay answered 401');
  });
});

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
    setMailSender(undefined);
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
      setMailSender(undefined);

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
    setMailSender(undefined);
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

  it('keeps jobs with the same period apart on every turn, not only the first', async () => {
    const started = Date.now();
    const runs: Record<string, number[]> = { first: [], second: [], third: [] };
    const scheduler = startScheduler(
      Object.keys(runs).map((name) => ({
        name,
        everyMs: 60_000,
        run: async () => {
          runs[name]!.push(Date.now() - started);
        },
      })),
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 5_000);
    await scheduler.stop();
    // Each job's minute counts from its own first run, so the half second between them stays.
    expect(runs.first).toEqual([1_000, 61_000, 121_000, 181_000]);
    expect(runs.second).toEqual([1_500, 61_500, 121_500, 181_500]);
    expect(runs.third).toEqual([2_000, 62_000, 122_000, 182_000]);
  });
});
