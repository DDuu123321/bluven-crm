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
