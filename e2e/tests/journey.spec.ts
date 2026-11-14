import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { expectStage, file, folder, pdf, png, shot, signIn, state } from './helpers';

// One lead, followed from the Bluven website all the way to the closed job: opened by the
// salesperson, proposal, deposit, pushed to operations, installed, final payment.
test.describe.configure({ mode: 'serial' });

let orderUrl = '';
let orderNo = '';

const lead = {
  externalId: 'bluven-1042',
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  sourceDetail: 'website/quote-form',
  firstName: 'Jane',
  lastName: 'Smith',
  phone: '0412 345 678',
  email: 'jane.smith@example.com',
  address: '12 Sample St',
  suburb: 'Parramatta',
  state: 'NSW',
  postcode: '2150',
  propertyType: 'House',
  components: ['Solar', 'Battery'],
  monthlyBill: 350,
  timeline: '1-month',
  bestTime: 'afternoon',
  notes: 'Wants backup for blackouts.',
};

function post(body: unknown, token: string) {
  return fetch(`${E2E.baseURL}/api/intake/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function openTab(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
}

test('the Bluven website forwards a lead over the API', async () => {
  const token = state().intakeToken;

  expect((await fetch(`${E2E.baseURL}/api/intake/health`)).status).toBe(200);
  expect((await post({ leads: [lead] }, 'blv_not-a-real-token')).status).toBe(401);
  expect((await post({ leads: [] }, token)).status).toBe(400);
  expect((await post({ nope: true }, token)).status).toBe(400);

  // A dry run validates without saving.
  const dry = await (await post({ leads: [lead], dryRun: true }, token)).json();
  expect(dry).toMatchObject({ received: 1, created: 1, results: [{ index: 0, ok: true, status: 'created', id: null }] });

  const first = await post({ leads: [lead, { ...lead, externalId: 'bad-1', state: 'New South Wales' }] }, token);
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body).toMatchObject({ received: 2, created: 1, failed: 1 });
  expect(body.results[0]).toMatchObject({ ok: true, status: 'created' });
  expect(body.results[0].orderNo).toMatch(/^BLV-\d{4}-00001$/);
  expect(body.results[1]).toEqual({ index: 1, ok: false, error: 'state: must be one of NSW, VIC, QLD, SA, WA, TAS, ACT, NT' });
  orderNo = body.results[0].orderNo;

  // Sending it again changes nothing.
  const again = await (await post({ leads: [lead] }, token)).json();
  expect(again.results[0]).toMatchObject({ status: 'already_received', id: body.results[0].id });

  // A second enquiry from the same person at the same address joins the open order.
  const repeat = await (await post({ leads: [{ ...lead, externalId: 'bluven-1043', phone: '+61 412 345 678', notes: 'Please call after 3pm.' }] }, token)).json();
  expect(repeat.results[0]).toMatchObject({ status: 'duplicate', id: body.results[0].id });

  // Oversized bodies are refused.
  expect((await post({ leads: [{ ...lead, notes: 'x'.repeat(120_000) }] }, token)).status).toBe(413);
});

test('a salesperson cannot see the lead while it sits in the pool', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByText('No orders here')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search orders' }).fill('Jane');
  await page.keyboard.press('Enter');
  await expect(page.getByText('No orders match your search')).toBeVisible();
  await context.close();
});

test('the manager assigns the lead', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'manager');
  await expect(page).toHaveURL(/\/dashboard$/);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: /Unassigned leads\s*1/ })).toBeVisible();

  await nav.getByRole('link', { name: /Unassigned leads/ }).click();
  await expect(page.getByRole('link', { name: 'Jane Smith' })).toBeVisible();
  await shot(page, '01-unassigned-pool');

  await page.getByLabel('Select Jane Smith').check();
  await page.getByLabel('Assign selected to').selectOption({ label: 'Sam Sales (0 open)' });
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText('The pool is empty')).toBeVisible();
  await context.close();
});

test('the salesperson opens the job and works it up to the deposit', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Notifications\s*1/ })).toBeVisible();
  await page.getByRole('link', { name: 'Jane Smith' }).click();
  await expect(page.locator('h1')).toContainText(orderNo);
  orderUrl = page.url();
  await expectStage(page, 'New');

  // The repeat enquiry is on the timeline, and the address came through.
  await expect(page.getByText('Repeat enquiry received via Bluven website')).toBeVisible();
  await expect(page.getByText('12 Sample St, Parramatta NSW 2150').first()).toBeVisible();

  // ---- until the job is opened it is only a lead: nothing can be recorded on it
  await expect(page.getByRole('heading', { name: 'Open this job' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to timeline' })).toHaveCount(0);
  await page.goto(`${orderUrl}?tab=documents`);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.goto(orderUrl);

  // ---- opening it asks where the customer came from: New -> Following up
  await page.getByLabel('Lead source').selectOption({ label: 'Partner' });
  await page.locator('#open-note').fill('Northside Electrical');
  await page.getByRole('button', { name: 'Open job' }).click();
  await expectStage(page, 'Following up');
  await expect(page.getByText(/Salesperson: Sam Sales · Lead source: Partner \(Northside Electrical\)/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open this job' })).toHaveCount(0);

  // ---- log a call: the customer is being followed up
  await page.getByRole('radio', { name: 'Call' }).click();
  await page.getByLabel('What happened').fill('Talked through a 6.6 kW system with a battery. Sending a proposal today.');
  await page.getByRole('button', { name: 'Add to timeline' }).click();
  await expect(page.getByText('Outgoing call: spoke with customer')).toBeVisible();
  await expectStage(page, 'Following up');
  // Newest first: the call just logged sits above the assignment that came before it.
  const entries = await page.locator('ol > li p:first-child').allTextContents();
  expect(entries.indexOf('Outgoing call: spoke with customer')).toBeLessThan(entries.indexOf('Assigned to Sam Sales'));

  // ---- a follow-up task
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByRole('dialog').getByLabel('What needs doing?').fill('Send the proposal');
  await page.getByRole('dialog').getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Send the proposal', { exact: true })).toBeVisible();
  await shot(page, '02-order-overview');

  // ---- the customer wants a proposal: Following up -> Design
  await page.getByRole('button', { name: 'The customer wants a proposal' }).click();
  await expectStage(page, 'Design');

  // ---- a quote version keeps the stage, sending it moves to Proposal sent
  await openTab(page, 'Proposal & deposit');
  await expect(page.getByRole('link', { name: 'Design in Pylon' })).toHaveAttribute('href', new RegExp(`reference_number=${orderNo}`));
  await page.getByRole('button', { name: 'Add quote version' }).click();
  const quote = page.getByRole('dialog');
  await quote.getByLabel('Short description').fill('6.6 kW solar with 13.5 kWh battery');
  await quote.getByLabel('Solar size (kW)').fill('6.6');
  await quote.getByLabel('Battery (kWh)').fill('13.5');
  await quote.getByLabel('Total price').fill('18,500');
  await quote.getByLabel('Deposit ($)').fill('1850');
  await quote.getByLabel('Quote file (PDF)').setInputFiles(file('Proposal - Jane Smith.pdf', pdf('proposal v1'), 'application/pdf'));
  await quote.getByRole('button', { name: 'Add version' }).click();
  await expect(page.getByRole('cell', { name: '6.6 kW + 13.5 kWh battery' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '$18,500.00' })).toBeVisible();
  await expectStage(page, 'Design');

  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark as sent' }).click();
  await expectStage(page, 'Proposal sent');

  // ---- the deposit needs no contract and nobody's confirmation; the amount is pre-filled from the proposal
  await expect(page.getByLabel('Amount paid ($)')).toHaveValue('1850.00');
  await page.getByLabel('Payment screenshot, receipt or finance approval').setInputFiles(file('transfer.png', png(1), 'image/png'));
  await page.locator('#deposit-note').fill('Paid from J Smith, reference SOLAR12.');
  await page.getByRole('button', { name: 'Record deposit' }).click();
  await expectStage(page, 'Deposit paid');
  await expect(page.getByText('Recorded, to be confirmed by operations')).toBeVisible();
  // Recording it says which proposal the customer went ahead with.
  await expect(page.getByText('Accepted by customer')).toBeVisible();
  await shot(page, '03-proposal-and-deposit');

  // ---- pushing is not possible until the folder is complete
  await openTab(page, 'Handoff');
  await expect(page.getByText('3 to go')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Push to operations' })).toBeDisabled();
  await context.close();
});

test('operations cannot see the order before it is pushed', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'ops');
  await expect(page).toHaveURL(/\/ops$/);
  await expect(page.getByText('Nothing is waiting')).toBeVisible();
  // A real 404, not a streamed page that only looks like one.
  const response = await page.goto(orderUrl);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: /does not exist, or it is not yours to see/ })).toBeVisible();
  await expect(page.getByText(orderNo)).toHaveCount(0);
  const opsPage = await page.goto(orderUrl.replace('/orders/', '/ops/orders/'));
  expect(opsPage?.status()).toBe(404);
  // The salespeople's list is not theirs either, and says so the same way rather than failing.
  expect((await page.goto('/orders'))?.status()).toBe(404);
  await context.close();
});

test('finance sees the deposit and has nothing to decide', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'fin');
  await expect(page).toHaveURL(/\/finance$/);
  const recorded = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Recorded by sales, not confirmed yet' }) });
  await expect(recorded.getByRole('cell', { name: orderNo })).toBeVisible();
  await expect(recorded.getByRole('cell', { name: '$1,850.00' })).toBeVisible();
  await expect(page.getByText('No deposit has been confirmed yet')).toBeVisible();
  await recorded.getByRole('link', { name: 'Open' }).click();

  await expect(page.getByText('Paid from J Smith, reference SOLAR12.')).toBeVisible();
  await expect(page.getByText('transfer.png')).toBeVisible();
  await expect(page.getByText('There is nothing to decide here.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0); // nothing on this page decides anything
  await shot(page, '04-finance-deposit');

  // Finance sees the money of an order, not the rest of it.
  const orderPage = await page.context().request.get(orderUrl, { maxRedirects: 0 });
  expect(orderPage.status()).toBe(307);
  await context.close();
});

test('the salesperson completes the folder and pushes to operations', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.goto(orderUrl);
  await expectStage(page, 'Deposit paid');

  await openTab(page, 'Documents');
  await folder(page, 'Electricity bill').locator('input[type=file]').last().setInputFiles(file('AGL bill Oct 2026.pdf', pdf('bill'), 'application/pdf'));
  await expect(folder(page, 'Electricity bill').getByText('AGL bill Oct 2026.pdf')).toBeVisible();
  await folder(page, 'Installation location photos').locator('input[type=file]').last().setInputFiles([file('garage-wall.png', png(2), 'image/png'), file('roof-north.png', png(3), 'image/png')]);
  await expect(folder(page, 'Installation location photos').getByText('roof-north.png')).toBeVisible();
  await folder(page, 'Meter box / switchboard photos').locator('input[type=file]').last().setInputFiles(file('meter-box.png', png(4), 'image/png'));
  await expect(folder(page, 'Meter box / switchboard photos').getByText('meter-box.png')).toBeVisible();
  await expect(folder(page, 'Meter box / switchboard photos').getByText('Required · done')).toBeVisible();
  // Thumbnails are generated for images.
  await expect(folder(page, 'Meter box / switchboard photos').locator('img')).toHaveCount(1);
  await shot(page, '05-documents');

  // The same file cannot be uploaded twice into the same folder.
  await folder(page, 'Meter box / switchboard photos').locator('input[type=file]').last().setInputFiles(file('meter-box-again.png', png(4), 'image/png'));
  await expect(folder(page, 'Meter box / switchboard photos').getByText(/already been uploaded here/)).toBeVisible();

  await openTab(page, 'Handoff');
  await expect(page.getByText('Complete', { exact: true })).toBeVisible();
  await page.getByLabel('Notes for operations').fill('Customer prefers mornings. Friendly dog in the back yard.');
  await shot(page, '06-handoff-ready');
  await page.getByRole('button', { name: 'Push to operations' }).click();
  await expectStage(page, 'Pushed to Ops');

  // Read-only while operations has it.
  await openTab(page, 'Documents');
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await context.close();
});

test('operations returns the order with a reason', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'ops');
  await expect(page.getByRole('cell', { name: orderNo })).toBeVisible();
  await page.getByRole('link', { name: 'Review' }).click();

  await expect(page.locator('h1')).toContainText('Jane Smith');
  await expect(page.getByText('Customer prefers mornings. Friendly dog in the back yard.').first()).toBeVisible();
  await expect(page.getByText('6.6 kW + 13.5 kWh battery').first()).toBeVisible();
  await expect(page.getByText('$16,650.00')).toBeVisible(); // balance to collect after the deposit
  await expect(page.getByText('To be confirmed when you accept')).toBeVisible();
  await expect(page.getByText('meter-box.png').first()).toBeVisible();
  await shot(page, '07-ops-review');

  // Operations can open the files of a pushed order.
  const href = await page.getByRole('link', { name: 'AGL bill Oct 2026.pdf' }).first().getAttribute('href');
  const download = await page.context().request.get(href!);
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toBe('application/pdf');

  await page.getByRole('button', { name: 'Return to sales' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Why is the salesperson needed?').fill('The customer does not answer our calls. Please check the best time and the number with her.');
  await dialog.getByLabel('Meter box / switchboard photos').check();
  await dialog.getByRole('button', { name: 'Return to sales' }).click();
  await expect(page.getByText(/^Returned to sales /).first()).toBeVisible();
  await page.goto('/ops');
  await expect(page.getByText('Nothing is waiting')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /Back with sales\s*1/ })).toBeVisible();
  await context.close();
});

test('the salesperson sorts it out and pushes the order again', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.goto(orderUrl);
  await expectStage(page, 'Returned by Ops');
  await expect(page.getByText('The customer does not answer our calls.', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Returned by operations: sort it out and push again').first()).toBeVisible(); // the task
  await shot(page, '08-returned-to-sales');

  await openTab(page, 'Documents');
  await folder(page, 'Meter box / switchboard photos').locator('input[type=file]').last().setInputFiles(file('meter-box-door-open.png', png(5), 'image/png'));
  await expect(folder(page, 'Meter box / switchboard photos').getByText('meter-box-door-open.png')).toBeVisible();

  await openTab(page, 'Handoff');
  await page.getByRole('button', { name: 'Push to operations again' }).click();
  await expectStage(page, 'Pushed to Ops');
  await expect(page.getByText('Submission 2').first()).toBeVisible();
  await context.close();
});

test('operations accepts the order, arranges the job and marks it as done', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'ops');
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByText('Returned 1 time before')).toBeVisible();
  await expect(page.getByText('meter-box-door-open.png').first()).toBeVisible();

  // ---- accepting is confirming that the deposit has arrived
  await page.getByRole('button', { name: 'Accept order' }).click();
  const accept = page.getByRole('dialog');
  await expect(accept.getByText('transfer.png')).toBeVisible();
  await accept.getByLabel('The deposit of $1,850.00 has arrived in the account').check();
  await accept.getByRole('button', { name: 'Accept order' }).click();
  await expect(page.getByText(/^Accepted /).first()).toBeVisible();
  await expectStage(page, 'With operations');
  await expect(page.getByText('Confirmed as received', { exact: true })).toBeVisible();
  // The customer is welcomed by an e-mail that is written at this moment.
  const notices = page.locator('section').filter({ has: page.getByRole('heading', { name: 'E-mails to the customer' }) });
  await expect(notices.getByText('Welcome', { exact: true })).toBeVisible();
  await expect(notices.getByText('to jane.smith@example.com', { exact: false })).toBeVisible();

  // ---- the items stand side by side: fill in what is settled
  const job = page.locator('section').filter({ has: page.getByRole('heading', { name: 'The job', exact: true }) });
  await expect(job.getByText('6 open')).toBeVisible();
  await job.getByLabel('Connection approval').selectOption({ label: 'Approved' });
  await job.locator('#job-ca-ref').fill('CA-2026-0042');
  await job.getByLabel('Job assigned on').selectOption({ label: 'Formbay' });
  await job.getByLabel('Installer', { exact: true }).fill('Joe Volt');
  await job.getByLabel('Electrician licence number').fill('EC 12345');
  await job.getByLabel('Installation date').fill('2027-01-12');
  await job.getByLabel('Stock').selectOption({ label: 'In stock, nothing to buy' });
  await job.getByLabel('Delivery').selectOption({ label: 'The installer picks it up' });
  await job.getByRole('button', { name: 'Save' }).click();
  await expect(job.getByText('All settled')).toBeVisible();

  // ---- the customer is told the dates when operations says so
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Send the dates to the customer' }).click();
  await expect(page.getByText('The customer has been told the dates as they stand now.')).toBeVisible();
  await expect(notices.getByText('Installation and delivery dates')).toBeVisible();

  // ---- what operations gets from the customer or the installer goes into the folder too
  await page.locator('#folder-approvals input[type=file]').setInputFiles(file('connection-approval.pdf', pdf('connection approval'), 'application/pdf'));
  await expect(page.locator('#folder-approvals').getByText('connection-approval.pdf')).toBeVisible();
  // A file from sales stays as it is; their own they can take back.
  await expect(page.locator('#folder-meter_box').getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(page.locator('#folder-approvals').getByRole('button', { name: 'Remove' })).toHaveCount(1);

  // ---- a note about the job, for sales to read
  await page.getByLabel('Add a note').fill('Steep roof: two installers booked.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Steep roof: two installers booked.').first()).toBeVisible();
  await shot(page, '09-ops-job');

  // ---- job done: the customer is thanked and asked for the balance
  await page.getByRole('button', { name: 'Job done' }).click();
  await expectStage(page, 'Installed, balance due');
  await expect(notices.getByText('Thank you and balance')).toBeVisible();
  await page.getByRole('button', { name: 'Rebate applied for' }).click();
  await expect(page.getByText(/^Applied for on /)).toBeVisible();

  // ---- the balance has not come in: sales is asked to chase it
  await page.getByRole('button', { name: 'Ask sales to chase the balance' }).click();
  await page.getByRole('dialog').locator('#chase-note').fill('$16,650.00 is still open.');
  await page.getByRole('dialog').getByRole('button', { name: 'Ask sales' }).click();
  await expect(page.getByText('Sales asked to chase', { exact: true })).toBeVisible();
  await shot(page, '10-ops-after-installation');

  await page.goto('/ops?tab=installed');
  await expect(page.getByRole('cell', { name: orderNo })).toBeVisible();
  await expect(page.getByText('Applied for', { exact: true })).toBeVisible();
  await context.close();
});

test('the salesperson follows the job and is asked for the balance', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'sam');
  await page.goto(orderUrl);
  await expectStage(page, 'Installed, balance due');
  await expect(page.getByText(/The installation was done on/)).toBeVisible();
  await expect(page.getByText('Ask the customer for the balance').first()).toBeVisible(); // the task
  await expect(page.getByText('$16,650.00 is still open.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  // Notes are still possible while operations has the order.
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Rang Jane about the balance. She pays on Friday.');
  await page.getByRole('button', { name: 'Add to timeline' }).click();
  await expect(page.getByText('Rang Jane about the balance.', { exact: false }).first()).toBeVisible();

  // What operations has arranged is there to read, and only to read.
  await openTab(page, 'Operations');
  await expect(page.getByText('Joe Volt, licence EC 12345')).toBeVisible();
  await expect(page.getByText('Approved (CA-2026-0042)')).toBeVisible();
  await expect(page.getByText('Steep roof: two installers booked.')).toBeVisible();
  await expect(page.getByText('Thank you and balance')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await shot(page, '11-order-operations-tab');
  // What operations filed is in the order's folder, for the salesperson to read.
  await openTab(page, 'Documents');
  await expect(folder(page, 'Approvals and certificates').getByText('connection-approval.pdf')).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await context.close();
});

test('finance confirms the final payment and the job is closed', async ({ browser }) => {
  const fin = await signIn(browser, 'fin');
  // The deposit was confirmed by operations; finance was told.
  const received = fin.page.locator('section').filter({ has: fin.page.getByRole('heading', { name: 'Received', exact: true }) });
  await expect(received.getByRole('cell', { name: orderNo })).toBeVisible();
  await expect(fin.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Notifications\s*1/ })).toBeVisible();

  await fin.page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /Balances due\s*1/ }).click();
  await expect(fin.page.getByRole('cell', { name: orderNo })).toBeVisible();
  await expect(fin.page.getByText('$16,650.00').first()).toBeVisible();
  await fin.page.getByRole('button', { name: 'Final payment received' }).click();
  const dialog = fin.page.getByRole('dialog');
  await dialog.getByLabel(/^Amount received/).fill('16650');
  await dialog.getByLabel(/^Note/).fill('NAB 20270115-7731');
  await dialog.getByRole('button', { name: 'Close the job' }).click();
  await expect(fin.page.getByText('No balance is due')).toBeVisible();
  await fin.page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Final payments received' }).click();
  await expect(fin.page.getByRole('cell', { name: orderNo })).toBeVisible();
  await expect(fin.page.getByRole('cell', { name: 'NAB 20270115-7731' })).toBeVisible();
  await shot(fin.page, '12-finance-final-payments');
  await fin.context.close();

  const sam = await signIn(browser, 'sam');
  await sam.page.goto(orderUrl);
  await expectStage(sam.page, 'Completed');
  await expect(sam.page.getByText(/The final payment arrived and the job was closed on/)).toBeVisible();
  // The task to chase the balance is done with it.
  await expect(sam.page.getByRole('button', { name: 'Done' })).toHaveCount(1); // only the task Sam added himself is still open
  await sam.page.goto('/orders?view=completed');
  await expect(sam.page.getByRole('link', { name: 'Jane Smith' })).toBeVisible();
  await sam.context.close();
});

test('another salesperson cannot reach the order or its files', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'alex');
  const response = await page.goto(orderUrl);
  expect(response?.status()).toBe(404);

  // Entering the same contact tells Alex only that it is taken.
  await page.goto('/orders/new');
  await page.getByLabel('First name').fill('Jane');
  await page.getByLabel('Phone').fill('0412 345 678');
  await expect(page.getByText('This contact already exists in the CRM and is not assigned to you.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not assigned to you' })).toBeVisible();
  await expect(page.getByText('Sam Sales')).toHaveCount(0);
  await context.close();
});

test('the manager sees the whole story in the dashboard and the audit log', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'manager');
  await expect(page.getByText('New leads', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Bluven website' })).toBeVisible();
  // Where the customer came from, as the salesperson said when opening the job: what partners are paid by.
  const bySource = page.locator('section').filter({ has: page.getByRole('heading', { name: 'By lead source' }) });
  await expect(bySource.getByRole('row').filter({ hasText: 'Partner' }).getByRole('cell')).toHaveText(['Partner', '1', '1', '$18,500.00', '1']);
  await shot(page, '13-dashboard');

  // Fetching a file in pieces is still an access that gets logged, and a HEAD request gets headers only.
  await page.goto(`${orderUrl}?tab=documents`);
  const fileUrl = (await page.locator('a[href^="/api/documents/"]').first().getAttribute('href'))!.split('?')[0]!;
  const head = await page.context().request.fetch(fileUrl, { method: 'HEAD', headers: { Range: 'bytes=1-' } });
  expect(head.status()).toBe(206);
  expect((await head.body()).length).toBe(0);
  const part = await page.context().request.get(fileUrl, { headers: { Range: 'bytes=1-' } });
  expect(part.status()).toBe(206);
  expect(part.headers()['content-range']).toMatch(/^bytes 1-\d+\/\d+$/);

  await page.goto(`${orderUrl}?tab=history`);
  for (const action of ['order.create', 'order.assign', 'order.open', 'quote.sent', 'deposit.submit', 'handoff.push', 'handoff.return', 'handoff.accept', 'deposit.confirm', 'ops.update', 'ops.job_done', 'ops.final_payment', 'document.view']) {
    await expect(page.getByText(action, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole('row').filter({ hasText: 'document.view' }).filter({ hasText: 'Morgan Manager' })).toHaveCount(1);

  await page.goto('/audit');
  await page.getByLabel('Order number').fill(orderNo);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('cell', { name: /Fay Finance/ }).first()).toBeVisible();
  await shot(page, '14-audit-log');

  const csv = await page.context().request.get(`/api/audit/export?order=${orderNo}`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('deposit.confirm');
  await context.close();
});

test('Pylon events are accepted only with a valid signature', async ({ browser }) => {
  const send = (body: string, headers: Record<string, string>) => fetch(`${E2E.baseURL}/api/webhooks/pylon`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const sign = (body: string, secret: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return { 'Pylon-Webhook-Timestamp': timestamp, 'Pylon-Webhook-Signature': `hs256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`, 'Pylon-Webhook-Version': '2021-07' };
  };
  const body = JSON.stringify({
    data: {
      type: 'events',
      id: 'evt_e2e_1',
      attributes: { name: 'solar_projects.created', created_at: new Date().toISOString(), project_reference_number: orderNo, project_in_app_url: 'https://app.getpylon.com/projects/prj_e2e' },
      relationships: { solar_project: { data: { type: 'solar_projects', id: 'prj_e2e' } } },
    },
  });

  expect((await send(body, {})).status).toBe(401);
  expect((await send(body, sign(body, 'the-wrong-secret'))).status).toBe(401);
  // A signature for one body does not cover another.
  expect((await send(body.replace(orderNo, 'BLV-0000-00000'), sign(body, E2E.pylonWebhookSecret))).status).toBe(401);

  // Too large is refused before anything else is looked at.
  expect((await send('x'.repeat(1024 * 1024 + 1), sign('x', E2E.pylonWebhookSecret))).status).toBe(413);

  const accepted = await send(body, sign(body, E2E.pylonWebhookSecret));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ ok: true, duplicate: false });
  // Pylon retries deliveries: the same event is stored once.
  expect(await (await send(body, sign(body, E2E.pylonWebhookSecret))).json()).toEqual({ ok: true, duplicate: true });

  const admin = await signIn(browser, 'admin');
  await admin.page.goto('/settings/pylon');
  await expect(admin.page.getByRole('cell', { name: 'solar_projects.created' })).toHaveCount(1);
  await expect(admin.page.getByText('Waiting', { exact: true })).toBeVisible();
  await shot(admin.page, '15-pylon-settings');
  await admin.context.close();

  // Not for other roles.
  const manager = await signIn(browser, 'manager');
  expect((await manager.page.goto('/settings/pylon'))?.status()).toBe(404);
  await manager.context.close();
});

test('an admin can add a user who must change their password at first sign-in', async ({ browser }) => {
  const admin = await signIn(browser, 'admin');
  await admin.page.goto('/settings/users');
  await admin.page.getByRole('button', { name: 'Add user' }).click();
  const dialog = admin.page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Nina New');
  await dialog.getByLabel('Email').fill('nina@bluven.test');
  await dialog.getByLabel('Temporary password').fill('Temporary-pass-1');
  await dialog.getByRole('button', { name: 'Add user' }).click();
  await expect(admin.page.getByRole('cell', { name: 'nina@bluven.test' })).toBeVisible();
  await expect(admin.page.getByText('Temporary password').first()).toBeVisible();
  await admin.context.close();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill('nina@bluven.test');
  await page.getByLabel('Password').fill('Temporary-pass-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account\/password$/);
  // Nothing else is reachable until the password is changed.
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/account\/password$/);
  await page.getByLabel('Current password').fill('Temporary-pass-1');
  await page.getByLabel('New password', { exact: true }).fill('My-own-password-22');
  await page.getByLabel('New password again').fill('My-own-password-22');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await context.close();
});
