// The background process. It owns everything that happens without a person clicking:
// idle reminders, holds that end, task reminders, the reminders after an installation,
// notification emails, the e-mails to customers and Pylon events.
import { getConfig, purgeExpiredSessions, runDocumentRetention, runHoldExpiry, runIdleRules, runOperationsReminders, runTaskReminders, systemCtx } from '@bluven/core';
import { getDb } from '@bluven/db';
import { PylonClient, assistantModel, createPacer, mailApiFactory, pollPylonEvents, processPylonEvents, pullBluvenLeads, purgePylonEvents, reconcilePylonEvents, runAssistantWork, sendCustomerNotices, setAsideCustomerNotices, syncAllMailboxes, zohoSettings } from '@bluven/integrations';
import { describeMailSetup, sendDailySummaries, sendNotificationEmails } from './mailer';
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
    // One e-mail each morning for the people who chose that over an e-mail per notification.
    name: 'daily-summaries',
    everyMs: 10 * MINUTE,
    run: async () => {
      const r = await sendDailySummaries(db);
      return some([[r.sent, 'daily summaries sent'], [r.failed, 'daily summaries failed']]);
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
    // After a job is done: operations is reminded to apply for the rebate, and that the balance is still open.
    name: 'operations-reminders',
    everyMs: 10 * MINUTE,
    run: async () => {
      const r = await runOperationsReminders(db);
      return some([[r.rebateReminders, 'rebate reminders'], [r.balanceReminders, 'balance reminders']]);
    },
  },
  {
    // Reminders before a retention period ends, the weekly reminder when nobody decides, automatic
    // deletion where an admin switched it on, and the removal of files 30 days after a deletion.
    name: 'document-retention',
    everyMs: HOUR,
    run: async () => {
      const r = await runDocumentRetention(db);
      return some([[r.reminders, 'retention reminders'], [r.repeatReminders, 'repeat reminders to managers'], [r.deleted, 'documents deleted at the end of retention'], [r.filesRemoved, 'files removed from storage']]);
    },
  },
  {
    name: 'session-cleanup',
    everyMs: 6 * HOUR,
    run: async () => some([[await purgeExpiredSessions(db), 'expired sessions removed']]),
  },
];

if (pylon) {
  jobs.push(
    {
      // What makes Pylon work with the API token alone: its event list is read every minute.
      // A webhook, once one is configured, only gets the same events here a little sooner.
      name: 'pylon-poll',
      everyMs: MINUTE,
      run: async () => {
        const r = await pollPylonEvents(systemCtx(db, 'Pylon'), pylon);
        if (r.error) return `could not read from Pylon: ${r.error}`;
        return some([[r.added, 'new Pylon events']]);
      },
    },
    {
      // The thorough pass: three days back, for anything the short reads did not see.
      name: 'pylon-reconcile',
      everyMs: 24 * HOUR,
      run: async () => {
        const ctx = systemCtx(db, 'Pylon');
        const found = await reconcilePylonEvents(ctx, pylon);
        const purged = await purgePylonEvents(ctx);
        return some([[found.added, 'missed Pylon events recovered'], [purged.removed, 'old unrelated Pylon events removed']]);
      },
    },
  );
}

const mail = zohoSettings();
if (mail) {
  // Zoho blocks an application that asks more than 30 times a minute, for a time it does not
  // disclose. One pacer for every mailbox keeps the reading well under that, evenly spread.
  const pace = createPacer(config.zoho.requestsPerMinute);
  jobs.push({
    // Connected mailboxes are read in turn, round after round; only mail with known customers is kept.
    name: 'mail-sync',
    everyMs: MINUTE,
    run: async () => {
      const r = await syncAllMailboxes(systemCtx(db, 'Mail'), mailApiFactory(db, { pace }));
      const done = some([[r.stored, 'e-mails added to timelines'], [r.failed, 'mailboxes could not be read'], [r.removed, 'mailboxes disconnected because their owner may no longer have one']]);
      return [done, r.pausedUntil && r.failed ? `reading is paused until ${r.pausedUntil.toISOString()}` : ''].filter(Boolean).join('; ') || undefined;
    },
  });
  jobs.push({
    // The welcome, the dates and the thank-you that operations' steps queue for the customer.
    name: 'customer-notices',
    everyMs: MINUTE,
    run: async () => {
      const r = await sendCustomerNotices(systemCtx(db, 'Operations e-mail'), { pace });
      return r ? some([[r.sent, 'e-mails to customers sent'], [r.waiting, 'will be tried again'], [r.stopped, 'could not be sent']]) : undefined;
    },
  });
} else {
  jobs.push({
    // Without customer e-mail nothing can go out: what is queued is set aside, with the reason, for operations to see.
    name: 'customer-notices',
    everyMs: MINUTE,
    run: async () => some([[await setAsideCustomerNotices(systemCtx(db, 'Operations e-mail')), 'e-mails to customers set aside: customer e-mail is not set up']]),
  });
}

const assistant = assistantModel();
if (assistant) {
  jobs.push({
    // Briefs for orders just pushed, a look at new attachments, new bills, summaries after a customer wrote.
    name: 'assistant',
    everyMs: MINUTE,
    run: async () => {
      const r = await runAssistantWork(systemCtx(db, 'Assistant'), assistant);
      if (!r) return undefined;
      if (r.setupProblem) return `not working, waiting for the key or the account to be fixed: ${r.setupProblem}`;
      if (r.serviceDown && r.failed === 0) return undefined; // waiting out an outage that was reported when it was found
      const done = some([[r.briefs, 'briefs for operations'], [r.attachments, 'attachments looked at'], [r.bills, 'bills read'], [r.summaries, 'summaries rewritten'], [r.failed, 'requests failed']]);
      return [done, r.serviceDown ? `the service could not be reached, waiting a few minutes: ${r.serviceDown}` : '', r.allowanceUsedUp ? 'the day’s allowance for automatic requests is used up' : ''].filter(Boolean).join('; ') || undefined;
    },
  });
}

const website = config.bluvenLeads;
if (website.url && website.key) {
  jobs.push({
    name: 'website-leads',
    everyMs: MINUTE,
    run: async () => {
      const r = await pullBluvenLeads(systemCtx(db, 'Bluven website'), { url: website.url, key: website.key, since: website.since });
      return r ? some([[r.created, 'new leads from the website'], [r.duplicates, 'repeat enquiries'], [r.failed, 'leads rejected']]) : undefined;
    },
  });
}

console.log(`[${new Date().toISOString()}] worker started (${jobs.map((j) => j.name).join(', ')})`);
console.log(
  `  time zone: ${config.timeZone} · notification emails: ${describeMailSetup()} · Pylon API: ${pylon ? 'on' : 'off (PYLON_API_TOKEN not set)'} · customer e-mail: ${mail ? `Zoho (${new URL(mail.mailUrl).host})` : 'off (ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET not set)'} · assistant: ${assistant ? assistant.name : 'off (ANTHROPIC_API_KEY not set)'} · website leads: ${
    website.url && website.key ? `pulled from ${new URL(website.url).host}` : 'not pulled (BLUVEN_LEADS_URL and BLUVEN_LEADS_KEY not set)'
  }`,
);

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
