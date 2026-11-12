import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { E2E, modelEnv, zohoEnv } from '../env';
import { shot, signIn, state } from './helpers';

// What keeps the CRM in order over time: ready-made e-mail texts, notifications by kind and the
// daily summary, the report with its export, and what happens to documents when their time is up.
test.describe.configure({ mode: 'serial' });

const lead = { externalId: 'keep-1', firstName: 'Rex', lastName: 'Retain', phone: '0415 777 888', email: 'rex.retain@example.com', address: '4 Archive Ave', suburb: 'Hornsby', state: 'NSW', postcode: '2077', components: ['Solar'] };
let orderUrl = '';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, DATABASE_URL: E2E.databaseUrl, STORAGE_DIR: E2E.storageDir, APP_URL: E2E.baseURL, ...zohoEnv, ...modelEnv };
const run = (script: string, args: string[] = []): unknown => JSON.parse(execFileSync('pnpm', ['exec', 'tsx', `scripts/${script}`, ...args], { cwd: here, env, encoding: 'utf8' }).trim().split('\n').pop()!);

test('a manager adds an e-mail template and a salesperson writes from it', async ({ browser }) => {
  const res = await fetch(`${E2E.baseURL}/api/intake/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state().intakeToken}` }, body: JSON.stringify({ leads: [lead] }) });
  expect(res.status).toBe(200);
  const manager = await signIn(browser, 'manager');
  await manager.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Unassigned leads/ }).click();
  await manager.page.getByLabel('Select Rex Retain').check();
  const sam = (await manager.page.getByLabel('Assign selected to').locator('option').allTextContents()).find((text) => text.startsWith('Sam Sales'))!;
  await manager.page.getByLabel('Assign selected to').selectOption({ label: sam });
  await manager.page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(manager.page.getByLabel('Select Rex Retain')).toHaveCount(0);

  await manager.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Email templates' }).click();
  // The texts to start from are there.
  await expect(manager.page.getByRole('cell', { name: 'First contact', exact: true })).toBeVisible();
  await manager.page.getByRole('button', { name: 'Add a template' }).click();
  const dialog = manager.page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Site visit');
  await dialog.getByLabel('Subject').fill('Your site visit at {{address}}');
  // A field that does not exist would reach the customer as it stands, so it is refused.
  await dialog.getByLabel('Text').fill('Hi {{firstname}},\n\nI will come by on [day].\n\n{{my_first_name}}');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByText('“{{firstname}}” is not a field')).toBeVisible();
  await dialog.getByLabel('Text').fill('Hi {{first_name}},\n\nI will come by on [day].\n\n{{my_first_name}}');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(manager.page.getByRole('cell', { name: 'Site visit', exact: true })).toBeVisible();
  await shot(manager.page, '18-email-templates');
  await manager.context.close();

  const { context, page } = await signIn(browser, 'sam');
  // Templates are a manager's to maintain.
  expect((await page.goto('/settings/email-templates'))!.status()).toBe(404);
  // The mailbox may have been connected by an earlier test of this run.
  await page.goto('/account/email');
  const connect = page.getByRole('link', { name: 'Connect Zoho Mail' });
  if (await connect.isVisible()) {
    await connect.click();
    await page.waitForURL(/\/account\/email\?connected=1/);
  }
  await page.goto('/orders');
  await page.getByRole('link', { name: 'Rex Retain' }).click();
  await page.waitForURL(/\/orders\/ord_/);
  orderUrl = page.url().split('?')[0]!;
  await page.goto(`${orderUrl}?tab=email`);
  await page.getByRole('button', { name: 'Write an email' }).click();
  const compose = page.getByRole('dialog');
  await compose.getByLabel(/Start from a template/).selectOption({ label: 'Site visit' });
  await expect(compose.getByLabel('Subject', { exact: true })).toHaveValue('Your site visit at 4 Archive Ave, Hornsby NSW 2077');
  await expect(compose.getByLabel('Message', { exact: true })).toHaveValue('Hi Rex,\n\nI will come by on [day].\n\nSam');
  await context.close();
});

test('notifications are filtered by kind, and the daily summary is each person’s choice', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Notifications/ }).click();
  const filter = page.getByRole('navigation', { name: 'Filter' });
  await expect(filter.getByRole('link', { name: 'All', exact: true })).toHaveAttribute('aria-current', 'true');
  // Sam has been assigned leads in this run; nothing from Pylon has been addressed to him.
  await filter.getByRole('link', { name: /Leads & assignments/ }).click();
  await expect(page).toHaveURL(/kind=leads/);
  await expect(page.getByText(/has been assigned to you/).first()).toBeVisible();
  await expect(page.getByText(/email from/i)).toHaveCount(0);
  await expect(filter.getByRole('link', { name: /Pylon/ })).toHaveCount(0);
  await shot(page, '19-notifications');

  const summary = page.getByLabel('Send me one summary each morning instead of an e-mail for every notification');
  await expect(summary).not.toBeChecked();
  await summary.check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Your first summary comes tomorrow morning.')).toBeVisible();
  await page.reload();
  await expect(summary).toBeChecked();
  await summary.uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('You get an e-mail for each notification again.')).toBeVisible();
  await context.close();
});

test('the report shows twelve months and idle orders by one measure, and exports the orders behind it', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'manager');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard' }).click();
  const months = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Last twelve months' }) });
  await expect(months.locator('tbody tr')).toHaveCount(12);
  const thisMonth = new Intl.DateTimeFormat('en-AU', { month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' }).format(new Date());
  await expect(months.locator('tbody tr').last()).toContainText(thisMonth);
  // Three tiers of the same count, each a link to exactly the orders it counts.
  for (const [label, href] of [['Idle 5+ days', '/orders?idle=1'], ['Idle 10+ days', '/orders?idle=2'], ['Idle 15+ days', '/orders?idle=3']] as const) {
    await expect(page.getByRole('link', { name: label })).toHaveAttribute('href', href);
  }
  await expect(page.getByRole('columnheader', { name: 'Days to sign' })).toBeVisible();
  await shot(page, '20-report');

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export orders (CSV)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^bluven-orders-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await context.request.get(await page.getByRole('link', { name: 'Export orders (CSV)' }).getAttribute('href').then((h) => h!))).text();
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  expect(lines[0]).toContain('"Order","Customer","Address","Source","Salesperson","Stage"');
  expect(lines.some((l) => l.includes('"Rex Retain","4 Archive Ave, Hornsby NSW 2077","Bluven website","Sam Sales","New"'))).toBe(true);
  // The export is on record.
  await page.goto('/audit?action=report.export');
  await expect(page.getByText(/Exported \d+ orders? with enquiries from/).first()).toBeVisible();
  await context.close();

  // A salesperson exports their own orders only; finance has no such report.
  const sam = await signIn(browser, 'sam');
  const own = await (await sam.context.request.get('/api/reports/orders?from=2020-01-01&to=2099-01-01')).text();
  expect(own).toContain('Rex Retain');
  expect(own).not.toContain('Alex Sales');
  await sam.context.close();
  const fin = await signIn(browser, 'fin');
  expect((await fin.context.request.get('/api/reports/orders')).status()).toBe(403);
  await fin.context.close();
});

test('documents near the end of their retention period wait for a decision', async ({ browser }) => {
  const orderId = orderUrl.split('/').pop()!;
  // Lost two years ago all but ten days: the two-year period ends in ten days.
  expect(run('lose-and-age.ts', [orderId, String(2 * 365 - 10)])).toMatchObject({ ok: true });

  const manager = await signIn(browser, 'manager');
  const nav = manager.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Documents to review/ });
  await expect(nav).toContainText('1');
  await nav.click();
  await expect(manager.page.getByText('1 order waiting for a decision')).toBeVisible();
  const row = manager.page.locator('tr').filter({ hasText: 'Rex Retain' });
  await expect(row).toContainText('Soon');
  await expect(row).toContainText('Lost');
  await row.getByRole('link').click();
  await manager.page.waitForURL(/tab=documents/);
  const card = manager.page.locator('#retention');
  await expect(card).toContainText('1 document reaches the end of its retention period on');
  await expect(card).toContainText('old-bill.pdf');
  await expect(card).toContainText('Nothing is deleted until someone decides.');
  await shot(manager.page, '21-retention');
  await card.getByRole('button', { name: 'Keep for another year' }).click();
  await expect(manager.page.locator('#retention')).toHaveCount(0);
  await expect(manager.page.getByText(/Its documents are kept until at least/)).toBeVisible();
  await manager.page.goto('/retention');
  await expect(manager.page.getByText('Nothing to review')).toBeVisible();
  // The decision is on the order's timeline.
  await manager.page.goto(orderUrl);
  await expect(manager.page.getByText(/Kept 1 document for another year, until/)).toBeVisible();
  await manager.context.close();

  // The period and the automatic-delete switch are an administrator's to set.
  const admin = await signIn(browser, 'admin');
  await admin.page.goto('/settings/rules');
  await expect(admin.page.getByLabel('Keep documents for')).toHaveValue('2');
  await admin.page.getByLabel('Keep documents for').fill('0');
  await admin.page.getByRole('button', { name: 'Save rules' }).click();
  await expect(admin.page.getByText('Enter a whole number of years between 1 and 50.')).toBeVisible();
  await admin.page.getByLabel('Keep documents for').fill('3');
  await admin.page.getByRole('button', { name: 'Save rules' }).click();
  await expect(admin.page.getByText('Rules saved.')).toBeVisible();
  await admin.page.reload();
  await expect(admin.page.getByLabel('Keep documents for')).toHaveValue('3');
  await admin.context.close();
});
