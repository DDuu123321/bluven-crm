import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { E2E, modelEnv, zohoEnv } from '../env';
import { pdf, shot, signIn, state } from './helpers';

// The assistant, against a stand-in for the language model: a summary and a suggestion taken
// over, a bill recognised, filed and read, a reply drafted and sent by a person, the brief for
// operations, and the administrator's page.
test.describe.configure({ mode: 'serial' });

const lead = { externalId: 'ai-1', firstName: 'Ava', lastName: 'Assist', phone: '0414 555 666', email: 'ava.assist@example.com', address: '8 Summary St', suburb: 'Epping', state: 'NSW', postcode: '2121', components: ['Solar', 'Battery'], notes: 'North-facing tiled roof' };
let orderUrl = '';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, DATABASE_URL: E2E.databaseUrl, STORAGE_DIR: E2E.storageDir, APP_URL: E2E.baseURL, ...zohoEnv, ...modelEnv };
const run = (script: string, args: string[] = []): unknown => JSON.parse(execFileSync('pnpm', ['exec', 'tsx', `scripts/${script}`, ...args], { cwd: here, env, encoding: 'utf8' }).trim().split('\n').pop()!);

/** Reads the mailboxes once, as the worker does every minute. */
const readMailboxes = () => run('sync-mail.ts') as { stored: number; failed: number };
/** One round of the assistant's background work. `later` runs it as if three minutes had passed. */
const assistantWork = (later = false) => run('assistant-work.ts', later ? ['--later'] : []) as { briefs: number; attachments: number; bills: number; summaries: number; failed: number; setupProblem: string | null };
/** Lets the assistant finish whatever earlier tests of this run left for it, so that what follows is about this order alone. */
function catchUp(): void {
  for (let round = 0; round < 12; round++) {
    const done = assistantWork(true);
    if (done.briefs + done.attachments + done.bills + done.summaries + done.failed === 0) return;
  }
  throw new Error('The assistant did not get through its background work.');
}
const modelRequests = async () => (await (await fetch(`${E2E.modelUrl}/__test/requests`)).json()) as { kind: string; model: string; effort: string | null; files: string[]; text: string }[];
const sentByCrm = async () => (await (await fetch(`${E2E.zohoUrl}/__test/sent`)).json()) as { to: string[]; subject: string; content: string; replyTo: string | null }[];

const card = (page: Page, title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test('a summary is written on request, and a detail it found is taken over into the property', async ({ browser }) => {
  const res = await fetch(`${E2E.baseURL}/api/intake/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state().intakeToken}` }, body: JSON.stringify({ leads: [lead] }) });
  expect(res.status).toBe(200);
  const manager = await signIn(browser, 'manager');
  await manager.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Unassigned leads/ }).click();
  await manager.page.getByLabel('Select Ava Assist').check();
  const sam = (await manager.page.getByLabel('Assign selected to').locator('option').allTextContents()).find((text) => text.startsWith('Sam Sales'))!;
  await manager.page.getByLabel('Assign selected to').selectOption({ label: sam });
  await manager.page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(manager.page.getByLabel('Select Ava Assist')).toHaveCount(0);
  await manager.context.close();

  const { context, page } = await signIn(browser, 'sam');
  await page.getByRole('link', { name: 'Ava Assist' }).click();
  await page.waitForURL(/\/orders\/ord_/);
  orderUrl = page.url().split('?')[0]!;

  const summary = page.locator('#summary');
  await expect(summary).toContainText('No summary yet');
  await summary.getByRole('button', { name: 'Write a summary' }).click();
  await expect(summary).toContainText('New enquiry for solar and a battery; nobody has spoken to the customer yet.');
  await expect(summary).toContainText('Next: Call the customer and ask for a recent electricity bill.');
  await expect(summary).toContainText('Whether the tiled roof is suitable');
  // It says who wrote it, and that it can be wrong.
  await expect(summary).toContainText('Written by AI');
  await expect(summary).toContainText('at Sam Sales’s request');
  await expect(summary).toContainText('It can be wrong');

  // The property has no roof on record; the summary found one, and a person decides to use it.
  await expect(summary).toContainText('Roof: Tile');
  await shot(page, '14-summary');
  await summary.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(summary.getByRole('button', { name: 'Use', exact: true })).toHaveCount(0);
  const property = card(page, 'Property');
  await expect(property).toContainText('Tile');
  await expect(property).toContainText('from the summary');

  // Only this order went to the model, without the customer's phone number or e-mail address.
  const requests = await modelRequests();
  const asked = requests.filter((r) => r.kind === 'summary');
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', files: [] });
  expect(asked[0]!.text).toContain('Ava Assist');
  expect(asked[0]!.text).toContain('North-facing tiled roof');
  expect(asked[0]!.text).not.toContain('ava.assist@example.com');
  expect(asked[0]!.text).not.toContain('0414');
  expect(asked[0]!.text).not.toContain('Mia Mailer');
  await context.close();
});

test('a bill sent by e-mail is recognised, filed with one click and read', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  // The mailbox may have been connected by an earlier test of this run.
  await page.goto('/account/email');
  const connect = page.getByRole('link', { name: 'Connect Zoho Mail' });
  if (await connect.isVisible()) {
    await connect.click();
    await page.waitForURL(/\/account\/email\?connected=1/);
  }

  catchUp();
  await fetch(`${E2E.zohoUrl}/__test/receive`, {
    method: 'POST',
    body: JSON.stringify({ from: lead.email, fromName: 'Ava Assist', subject: 'My electricity bill', html: '<p>Here is my latest bill.</p>', attachments: [{ name: 'scan0001.pdf', base64: pdf('AGL bill for Ava').toString('base64') }] }),
  });
  expect(readMailboxes()).toMatchObject({ stored: 1, failed: 0 });
  // The assistant looks at the attachment; nothing is filed yet.
  expect(assistantWork()).toMatchObject({ attachments: 1, bills: 0, failed: 0, setupProblem: null });

  await page.goto(`${orderUrl}?tab=email`);
  const message = page.locator('li').filter({ hasText: 'My electricity bill' }).first();
  await expect(message).toContainText('AI: Looks like: Electricity bill · AGL electricity bill for August to October 2026');
  const choice = message.getByLabel('Folder for scan0001.pdf');
  await expect(choice.locator('option:checked')).toHaveText('Electricity bill');
  await message.getByRole('button', { name: 'File', exact: true }).click();
  await expect(message.getByText('Filed as Electricity bill')).toBeVisible();

  // Once it is in the bill folder it is read.
  expect(assistantWork()).toMatchObject({ attachments: 0, bills: 1, failed: 0 });
  await page.goto(orderUrl);
  const bills = page.locator('#bills');
  await expect(bills).toContainText('Read by AI');
  await expect(bills).toContainText('AGL');
  await expect(bills).toContainText('1656 kWh · 18 kWh a day');
  await expect(bills).toContainText('$612.40');
  await expect(bills).toContainText('1 Aug 2026 to 31 Oct 2026');
  await expect(bills).toContainText('Filled in on the property from this bill: NMI, retailer');
  const property = card(page, 'Property');
  await expect(property).toContainText('41031234567');
  await expect(property).toContainText('from the bill');
  await expect(page.getByText('Electricity bill read: scan0001.pdf')).toBeVisible();
  await shot(page, '15-bill');

  const requests = await modelRequests();
  expect(requests.filter((r) => r.kind === 'attachment' && r.files.includes('document:scan0001.pdf'))).toEqual([expect.objectContaining({ effort: 'low' })]);
  expect(requests.filter((r) => r.kind === 'bill' && r.files.includes('document:scan0001.pdf'))).toHaveLength(1);
  await context.close();
});

test('a reply is drafted, then read, changed and sent by the salesperson', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.goto(`${orderUrl}?tab=email`);
  const before = (await sentByCrm()).length;
  const message = page.locator('li').filter({ hasText: 'My electricity bill' }).first();
  await message.getByRole('button', { name: 'Reply' }).click();
  const dialog = page.getByRole('dialog');
  const body = dialog.getByLabel('Message', { exact: true });
  await expect(body).toHaveValue('');
  await dialog.getByLabel(/Draft with AI/).fill('The battery is $8,900 extra');
  await dialog.getByRole('button', { name: 'Write a draft' }).click();
  await expect(body).toHaveValue(/Thanks for the bill, that is all I need for the design\. The battery is \$8,900 extra\./);
  await expect(dialog.getByText('Draft written by AI')).toBeVisible();
  // Nothing has gone out: a draft is only a draft.
  expect(await sentByCrm()).toHaveLength(before);

  // The salesperson fills in what the draft left open, and sends it.
  const draft = await body.inputValue();
  expect(draft).toContain('[installation date]');
  await body.fill(draft.replace('[installation date]', '3 December'));
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toBeHidden();
  const sent = await sentByCrm();
  expect(sent).toHaveLength(before + 1);
  expect(sent.at(-1)).toMatchObject({ to: [lead.email], subject: 'Re: My electricity bill' });
  expect(sent.at(-1)!.replyTo).not.toBeNull();
  expect(sent.at(-1)!.content).toContain('We can install on 3 December.');

  const asked = (await modelRequests()).filter((r) => r.kind === 'reply');
  expect(asked).toHaveLength(1);
  expect(asked[0]!.text).not.toContain('Mia Mailer');
  expect(asked[0]!.text).toContain('## The customer\'s message to answer');
  expect(asked[0]!.text).toContain('Here is my latest bill.');
  expect(asked[0]!.text).toContain('## What the salesperson wants to say\nThe battery is $8,900 extra');
  await context.close();
});

test('operations get a brief with the order', async ({ browser }) => {
  const orderId = orderUrl.split('/').pop()!;
  expect(run('push-order.ts', [orderId])).toMatchObject({ version: 1 });

  // Straight after the push the brief is on its way.
  const ops = await signIn(browser, 'ops');
  await ops.page.goto(`/ops/orders/${orderId}`);
  const brief = ops.page.locator('#brief');
  await expect(brief).toContainText('The brief is being written');

  // The customer wrote since the summary: it is rewritten too, without anyone asking.
  expect(assistantWork(true)).toMatchObject({ briefs: 1, summaries: 1, failed: 0 });
  await ops.page.reload();
  await expect(brief).toContainText('Written by AI');
  await expect(brief).toContainText('Ava Assist bought a 6.6 kW solar system for her house in Epping.');
  await expect(brief).toContainText('About 18 kWh a day according to the AGL bill');
  await expect(brief).toContainText('To check before booking');
  await expect(brief).toContainText('Supply phase is not recorded');
  // Operations also read the summary and what the bill says, and change neither.
  await expect(ops.page.locator('#summary')).toContainText('automatically, after the customer wrote');
  await expect(ops.page.locator('#summary').getByRole('button')).toHaveCount(0);
  await expect(ops.page.locator('#bills')).toContainText('41031234567');
  await expect(ops.page.locator('#bills').getByRole('button')).toHaveCount(0);
  await shot(ops.page, '16-brief');
  // They can have the brief written again.
  await brief.getByRole('button', { name: 'Write again' }).click();
  await expect(brief.getByRole('button', { name: 'Write again' })).toBeEnabled();
  expect((await modelRequests()).filter((r) => r.kind === 'brief' && r.text.includes('Ava Assist'))).toHaveLength(2);
  await ops.context.close();

  const sam = await signIn(browser, 'sam');
  await sam.page.goto(`${orderUrl}?tab=handoff`);
  await expect(sam.page.locator('#brief')).toContainText('Ava Assist bought a 6.6 kW solar system');
  await sam.context.close();
});

test('the administrator decides what it does by itself, and managers see what it used', async ({ browser }) => {
  const sam = await signIn(browser, 'sam');
  expect((await sam.page.goto('/settings/assistant'))!.status()).toBe(404);
  await sam.context.close();

  const manager = await signIn(browser, 'manager');
  await manager.page.goto('/settings/assistant');
  await expect(manager.page.getByRole('heading', { name: 'AI assistant' })).toBeVisible();
  await expect(manager.page.getByText('claude-opus-5-5')).toBeVisible();
  const usage = manager.page.locator('section').filter({ has: manager.page.getByRole('heading', { name: 'Use in the last 30 days' }) });
  // The second column is the number of requests: every kind of work was done at least once in this run.
  for (const work of ['Order summaries', 'Reply drafts', 'Recognising e-mail attachments', 'Reading electricity bills', 'Briefs for operations']) {
    await expect(usage.locator('tr').filter({ hasText: work }).locator('td').nth(1)).toHaveText(/^[1-9]/);
  }
  await expect(usage.locator('tr').filter({ hasText: 'All together' })).toContainText('about US$');
  // A manager reads; only an administrator changes.
  await expect(manager.page.getByLabel('Rewrite an order’s summary when the customer writes')).toBeDisabled();
  await expect(manager.page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await manager.context.close();

  const admin = await signIn(browser, 'admin');
  await admin.page.goto('/settings/assistant');
  await admin.page.getByLabel('Automatic requests in 24 hours, at most').fill('many');
  await admin.page.getByRole('button', { name: 'Save' }).click();
  await expect(admin.page.getByText('Enter a whole number.')).toBeVisible();
  await admin.page.getByLabel('Automatic requests in 24 hours, at most').fill('150');
  await admin.page.getByLabel('Rewrite an order’s summary when the customer writes').uncheck();
  await admin.page.getByLabel('Summaries and briefs are written in').selectOption({ label: 'Chinese (简体中文)' });
  await admin.page.getByRole('button', { name: 'Save' }).click();
  await expect(admin.page.getByText('Saved.')).toBeVisible();
  await admin.page.reload();
  await expect(admin.page.getByLabel('Rewrite an order’s summary when the customer writes')).not.toBeChecked();
  await expect(admin.page.getByLabel('Automatic requests in 24 hours, at most')).toHaveValue('150');
  await expect(admin.page.getByLabel('Summaries and briefs are written in')).toHaveValue('zh');
  await expect(admin.page.getByText('of at most 150')).toBeVisible();
  await shot(admin.page, '17-assistant-settings');
  await admin.context.close();
});
