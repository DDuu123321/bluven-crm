// The background process. It owns everything that happens without a person clicking:
// idle reminders, holds that end, task reminders, notification emails and Pylon events.
import { getConfig, purgeExpiredSessions, runHoldExpiry, runIdleRules, runTaskReminders, systemCtx } from '@bluven/core';
import { getDb } from '@bluven/db';
import { PylonClient, processPylonEvents, reconcilePylonEvents } from '@bluven/integrations';
import { sendNotificationEmails } from './mailer';
import { startScheduler, type Job } from './scheduler';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const db = getDb();
const config = getConfig();
const pylon = config.pylon.apiToken ? new PylonClient({ apiBase: config.pylon.apiBase, apiToken: config.pylon.apiToken }) : null;

const some = (parts: [number, string][]): string | void => {
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(', ');
  return text || undefined;
};

const jobs: Job[] = [
  {
    name: 'pylon-events',
    everyMs: 20 * SECOND,
    run: async () => {
      const r = await processPylonEvents(systemCtx(db, 'Pylon'), pylon);
      return some([[r.processed, 'processed'], [r.ignored, 'needed no action'], [r.retrying, 'will be retried'], [r.failed, 'failed']]);
    },
  },
  {
    name: 'task-reminders',
    everyMs: MINUTE,
    run: async () => some([[(await runTaskReminders(db)).reminded, 'task reminders']]),
  },
  {
    name: 'notification-emails',
    everyMs: MINUTE,
    run: async () => {
      const r = await sendNotificationEmails(db);
      return some([[r.sent, 'emails sent'], [r.failed, 'emails failed']]);
    },
  },
  {
    name: 'idle-rules',
    everyMs: 10 * MINUTE,
    run: async () => {
      const r = await runIdleRules(db);
      return some([[r.ownerReminders, 'salesperson reminders'], [r.managerReminders, 'manager reminders'], [r.returnedToPool, 'orders returned to the pool']]);
    },
  },
  {
    name: 'hold-expiry',
    everyMs: 10 * MINUTE,
    run: async () => some([[(await runHoldExpiry(db)).resumed, 'orders taken off hold']]),
  },
  {
    name: 'session-cleanup',
    everyMs: 6 * HOUR,
    run: async () => some([[await purgeExpiredSessions(db), 'expired sessions removed']]),
  },
];

if (pylon) {
  jobs.push({
    name: 'pylon-reconcile',
    everyMs: 24 * HOUR,
    run: async () => some([[(await reconcilePylonEvents(systemCtx(db, 'Pylon'), pylon)).added, 'missed Pylon events recovered']]),
  });
}

console.log(`[${new Date().toISOString()}] worker started (${jobs.map((j) => j.name).join(', ')})`);
console.log(`  time zone: ${config.timeZone} · notification emails: ${config.smtpUrl ? 'on' : 'off (SMTP_URL not set)'} · Pylon API: ${pylon ? 'on' : 'off (PYLON_API_TOKEN not set)'}`);

const scheduler = startScheduler(jobs);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[${new Date().toISOString()}] ${signal} received, finishing the jobs in progress`);
  await scheduler.stop();
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
