import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { E2E, zohoEnv } from '../env';
import { expectStage, file, folder, pdf, png, shot, signIn, state } from './helpers';

// E-mail with a customer, against a stand-in for Zoho: connecting a mailbox, writing from an
// order, the customer's answer arriving with an attachment, and filing that attachment.
test.describe.configure({ mode: 'serial' });

const lead = { externalId: 'mail-1', firstName: 'Mia', lastName: 'Mailer', phone: '0413 222 333', email: 'mia.mailer@example.com', address: '5 Letter Ln', suburb: 'Ryde', state: 'NSW', postcode: '2112', components: ['Solar'] };
const SUBJECT = 'Your solar options';
let orderUrl = '';

/** Reads the mailboxes once, as the worker does every minute. */
function readMailboxes(): { mailboxes: number; stored: number; failed: number } {
  const out = execFileSync('pnpm', ['exec', 'tsx', 'scripts/sync-mail.ts'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, DATABASE_URL: E2E.databaseUrl, STORAGE_DIR: E2E.storageDir, APP_URL: E2E.baseURL, ...zohoEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop()!) as { mailboxes: number; stored: number; failed: number };
}

const sentByCrm = async () => (await (await fetch(`${E2E.zohoUrl}/__test/sent`)).json()) as { to: string[]; subject: string; content: string; attachments: string[]; replyTo: string | null }[];

async function openTab(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
}

test('a salesperson connects their own mailbox', async ({ browser }) => {
  const res = await fetch(`${E2E.baseURL}/api/intake/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state().intakeToken}` }, body: JSON.stringify({ leads: [lead] }) });
  expect(res.status).toBe(200);

  const manager = await signIn(browser, 'manager');
  await manager.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Unassigned leads/ }).click();
  await manager.page.getByLabel('Select Mia Mailer').check();
  // The option carries the number of open orders, which depends on what ran before.
  const sam = (await manager.page.getByLabel('Assign selected to').locator('option').allTextContents()).find((text) => text.startsWith('Sam Sales'))!;
  await manager.page.getByLabel('Assign selected to').selectOption({ label: sam });
  await manager.page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(manager.page.getByText('The pool is empty')).toBeVisible();
  await manager.context.close();

  const { context, page } = await signIn(browser, 'sam');
  await page.getByRole('link', { name: 'Mia Mailer' }).click();
  await page.waitForURL(/\/orders\/ord_/);
  orderUrl = page.url().split('?')[0]!;

  // Without a mailbox the Email tab says so and offers the way to connect one.
  await openTab(page, 'Email');
  await expect(page.getByText('Your mailbox is not connected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write an email' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Connect your mailbox' }).first().click();
  await expect(page.getByRole('heading', { name: 'No mailbox connected' })).toBeVisible();
  // Off to "Zoho", which agrees at once, and back.
  await page.getByRole('link', { name: 'Connect Zoho Mail' }).click();
  await page.waitForURL(/\/account\/email\?connected=1/);
  await expect(page.getByText('Connected. E-mail with your customers')).toBeVisible();
  await expect(page.getByRole('heading', { name: E2E.mailbox })).toBeVisible();
  await context.close();
});

test('writes to the customer from the order, with a file of the order attached', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.goto(`${orderUrl}?tab=documents`);
  const photos = folder(page, 'Installation location photos');
  await photos.locator('input[type=file]').last().setInputFiles(file('roof-north.png', png(21), 'image/png'));
  await expect(photos.getByText('roof-north.png').first()).toBeVisible();

  await openTab(page, 'Email');
  await page.getByRole('button', { name: 'Write an email' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('To', { exact: true })).toHaveValue(lead.email);
  // A typo in the address must not send a customer's file to a stranger.
  await dialog.getByLabel('To', { exact: true }).fill('mia.mailer@exmaple.com');
  await dialog.getByLabel('Subject', { exact: true }).fill(SUBJECT);
  await dialog.getByLabel('Message', { exact: true }).fill('Hi Mia,\n\nHere is the roof we talked about. Could you send me a recent electricity bill?\n\nSam');
  await dialog.getByRole('checkbox', { name: /roof-north\.png/ }).check();
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.getByText('At least one recipient must be an address on this customer’s record')).toBeVisible();
  expect(await sentByCrm()).toHaveLength(0);

  await dialog.getByLabel('To', { exact: true }).fill(lead.email);
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(SUBJECT).first()).toBeVisible();
  await expect(page.getByText('written in the CRM')).toBeVisible();
  // Writing to the customer is first contact.
  await expectStage(page, 'Contacted');

  const sent = await sentByCrm();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: [lead.email], subject: SUBJECT, attachments: ['roof-north.png'], replyTo: null });
  expect(sent[0]!.content).toContain('Could you send me a recent electricity bill?');

  // When the sent folder is read, the message is recognised and not shown twice.
  expect(readMailboxes()).toMatchObject({ mailboxes: 1, stored: 0, failed: 0 });
  await page.reload();
  await expect(page.locator('li').filter({ hasText: SUBJECT })).toHaveCount(1);
  await context.close();
});

test('the customer’s answer arrives with its attachment, which is filed into the order', async ({ browser }) => {
  const received = await fetch(`${E2E.zohoUrl}/__test/receive`, {
    method: 'POST',
    body: JSON.stringify({
      from: lead.email,
      fromName: 'Mia Mailer',
      subject: `Re: ${SUBJECT}`,
      inReplyToSubject: SUBJECT,
      html: '<div>Hi Sam,</div><div>My latest bill is attached.</div><script>document.title="pwned"</script><img src="https://tracker.example/pixel.gif">',
      attachments: [{ name: 'AGL bill Oct.pdf', base64: pdf('AGL bill October').toString('base64') }],
    }),
  });
  expect(received.status).toBe(200);
  // Mail from someone the CRM does not know stays in the mailbox and out of the CRM.
  await fetch(`${E2E.zohoUrl}/__test/receive`, { method: 'POST', body: JSON.stringify({ from: 'newsletter@shop.example', subject: 'Big sale', html: '<p>Buy now</p>' }) });
  expect(readMailboxes()).toMatchObject({ mailboxes: 1, stored: 1, failed: 0 });

  const { context, page } = await signIn(browser, 'sam');
  // The salesperson is told in the CRM.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Notifications/ }).click();
  await expect(page.getByText(/email from Mia Mailer/)).toBeVisible();

  await page.goto(`${orderUrl}?tab=email`);
  const message = page.locator('li').filter({ hasText: `Re: ${SUBJECT}` }).first();
  await expect(message.getByText('Received')).toBeVisible();
  await expect(message.getByText('My latest bill is attached.')).toBeVisible();
  await expect(page.getByText('Big sale')).toHaveCount(0);

  // The attachment opens for the salesperson; the original formatting is shown as a document that can do nothing.
  const link = message.getByRole('link', { name: 'AGL bill Oct.pdf' });
  const attachment = await context.request.get((await link.getAttribute('href'))!);
  expect(attachment.status()).toBe(200);
  expect(attachment.headers()['content-type']).toBe('application/pdf');
  const original = await context.request.get((await message.getByRole('link', { name: 'View with original formatting' }).getAttribute('href'))!);
  expect(original.headers()['content-security-policy']).toContain('sandbox');
  expect(original.headers()['content-security-policy']).toContain("default-src 'none'");

  // File it where it belongs.
  await message.getByLabel('Folder for AGL bill Oct.pdf').selectOption({ label: 'Electricity bill' });
  await message.getByRole('button', { name: 'File', exact: true }).click();
  await expect(message.getByText('Filed as Electricity bill')).toBeVisible();
  await shot(page, '13-email');
  await openTab(page, 'Documents');
  await expect(folder(page, 'Electricity bill').getByText('AGL bill Oct.pdf').first()).toBeVisible();

  // The timeline carries both messages.
  await openTab(page, 'Overview');
  await expect(page.getByText(`Email from Mia Mailer: Re: ${SUBJECT}`)).toBeVisible();
  await expect(page.getByText(`Email to Mia Mailer: ${SUBJECT}`)).toBeVisible();
  await context.close();
});

test('a reply goes out in the same conversation', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.goto(`${orderUrl}?tab=email`);
  const message = page.locator('li').filter({ hasText: `Re: ${SUBJECT}` }).first();
  await message.getByRole('button', { name: 'Reply' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Subject', { exact: true })).toHaveValue(`Re: ${SUBJECT}`);
  await expect(dialog.getByLabel('To', { exact: true })).toHaveValue(lead.email);
  await dialog.getByLabel('Message', { exact: true }).fill('Thanks Mia, that is all I need.');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toBeHidden();

  const sent = await sentByCrm();
  expect(sent).toHaveLength(2);
  // Sent as an answer to the customer's message, so both mail programs keep the thread together.
  expect(sent[1]!.replyTo).not.toBeNull();
  expect(sent[1]).toMatchObject({ to: [lead.email], subject: `Re: ${SUBJECT}` });
  await context.close();
});

test('the correspondence is for the people on the order, and a manager sees who is connected', async ({ browser }) => {
  const alex = await signIn(browser, 'alex');
  expect((await alex.page.goto(`${orderUrl}?tab=email`))!.status()).toBe(404);
  await alex.context.close();

  const sam = await signIn(browser, 'sam');
  await sam.page.goto(`${orderUrl}?tab=email`);
  const href = (await sam.page.getByRole('link', { name: 'AGL bill Oct.pdf' }).first().getAttribute('href'))!;
  await sam.context.close();
  const stranger = await signIn(browser, 'alex');
  expect((await stranger.context.request.get(href)).status()).toBe(404);
  expect((await stranger.page.goto('/settings/email'))!.status()).toBe(404);
  await stranger.context.close();

  const manager = await signIn(browser, 'manager');
  await manager.page.goto('/settings/email');
  const row = manager.page.locator('tr').filter({ hasText: E2E.mailbox });
  await expect(row.getByText('Sam Sales')).toBeVisible();
  await expect(row.getByText('Working')).toBeVisible();
  await manager.context.close();
});

test('the owner decides how much of a mailbox is kept, and an address from the website form waits for a person', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.goto('/account/email');
  await expect(page.getByText('Now: Customers I work with.')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Keep e-mail with every customer' }).click();
  await expect(page.getByText('Now: Every customer in the CRM.')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Keep only e-mail with my own customers' }).click();
  await expect(page.getByText('Now: Customers I work with.')).toBeVisible();

  // Someone fills in the website form with Mia's phone number and an address of their own.
  const res = await fetch(`${E2E.baseURL}/api/intake/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state().intakeToken}` },
    body: JSON.stringify({ leads: [{ ...lead, externalId: 'mail-2', email: 'not.mia@example.net' }] }),
  });
  expect((await res.json()).results[0]).toMatchObject({ status: 'duplicate' });

  // The address is on the record, marked, and the order's mail cannot go to it.
  await page.goto(orderUrl);
  const marked = page.getByText('came with a website enquiry, not confirmed');
  await expect(marked).toBeVisible();
  await openTab(page, 'Email');
  await page.getByRole('button', { name: 'Write an email' }).click();
  const compose = page.getByRole('dialog');
  await compose.getByLabel('To', { exact: true }).fill('not.mia@example.net');
  await compose.getByLabel('Subject', { exact: true }).fill('Your contract');
  await compose.getByLabel('Message', { exact: true }).fill('Attached.');
  await compose.getByRole('button', { name: 'Send' }).click();
  await expect(compose.getByText(/nobody has confirmed that it is the customer’s/)).toBeVisible();
  expect((await sentByCrm()).some((m) => m.to.includes('not.mia@example.net'))).toBe(false);
  await page.keyboard.press('Escape');

  // A person who knows it is hers confirms it.
  await openTab(page, 'Overview');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(marked).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'not.mia@example.net' })).toBeVisible();
  await context.close();
});

test('a quote version gets its file, goes out by e-mail, and is recorded as sent by that', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.goto(orderUrl);
  await openTab(page, 'Quote, contract & deposit');
  // As a version arrives from Pylon: the figures, and no file.
  await page.getByRole('button', { name: 'Add quote version' }).click();
  const add = page.getByRole('dialog');
  await add.getByLabel('Short description').fill('8 kW solar');
  await add.getByLabel('Solar size (kW)').fill('8');
  await add.getByLabel('Total price').fill('8,400');
  await add.getByLabel('Deposit ($)').fill('840');
  await add.getByRole('button', { name: 'Add version' }).click();
  await expect(page.getByText('Not sent')).toBeVisible();

  await page.getByRole('button', { name: 'Attach file' }).click();
  const attach = page.getByRole('dialog');
  await attach.getByLabel('Quote file (PDF)').setInputFiles(file('Quote - Mia Mailer.pdf', pdf('quote for Mia'), 'application/pdf'));
  await attach.getByRole('button', { name: 'Attach file' }).click();
  await expect(page.getByRole('link', { name: 'Quote - Mia Mailer.pdf' })).toBeVisible();
  // Having a file is not having been sent.
  await expect(page.getByText('Not sent')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace file' })).toBeVisible();

  // Sent from the Email tab with the file attached: that is what records the version as sent.
  await openTab(page, 'Email');
  await page.getByRole('button', { name: 'Write an email' }).click();
  const compose = page.getByRole('dialog');
  await compose.getByLabel('Subject', { exact: true }).fill('Your quote');
  await compose.getByLabel('Message', { exact: true }).fill('Hi Mia,\n\nYour quote is attached.\n\nSam');
  await compose.getByRole('checkbox', { name: /Quote - Mia Mailer\.pdf/ }).check();
  await compose.getByRole('button', { name: 'Send' }).click();
  await expect(compose).toBeHidden();
  expect((await sentByCrm()).at(-1)).toMatchObject({ subject: 'Your quote', attachments: ['Quote - Mia Mailer.pdf'] });
  await openTab(page, 'Quote, contract & deposit');
  await expect(page.getByText('Not sent')).toHaveCount(0);
  await expectStage(page, 'Quoted');
  await context.close();
});
