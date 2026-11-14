// The e-mails the CRM sends to customers by itself, on their way out: through which mailbox,
// what is left behind on the order, and what happens when they cannot be sent.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptHandoff,
  cancelOrder,
  getOperationsSettings,
  listNotices,
  markJobDone,
  parseDateOnly,
  retryNotice,
  sendScheduleNotice,
  systemCtx,
  updateOperationsSettings,
  updateOpsJob,
  type Ctx,
} from '@bluven/core';
import { as, makeUser, resetDb, testDb } from '../../core/test/helpers';
import { makeWorld, orderAt, type World } from '../../core/test/setup-order';
import { MailApiError, buildOrderContext, getOrderMail, sendCustomerNotices, sendOrderEmail, setAsideCustomerNotices, type MailApi, type OutgoingMail } from '../src';

const db = testDb();
let w: World;
let ctx: Ctx;

/** Just enough of a mail service to send with. */
class Outbox {
  sent: (OutgoingMail & { account: string })[] = [];
  fail: MailApiError | null = null;
  api = (account: { providerAccountId: string }): MailApi =>
    ({
      send: async (_accountId: string, mail: OutgoingMail) => {
        if (this.fail) throw this.fail;
        this.sent.push({ ...mail, account: account.providerAccountId });
        return { messageId: `sent${this.sent.length}`, messageIdHeader: `notice-${this.sent.length}@mail.example` };
      },
    }) as unknown as MailApi;
}
let outbox: Outbox;

const mailbox = (userId: string, address: string) =>
  db.emailAccount.create({ data: { id: `mbx_${userId}`, userId, address, addresses: [address], displayName: '', providerAccountId: `acc_${address}`, refreshTokenEnc: 'x', syncFrom: w.clock.current } });
const send = () => sendCustomerNotices(ctx, { apiFor: outbox.api });

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
  ctx = systemCtx(db, 'Operations e-mail', w.clock.now);
  outbox = new Outbox();
});

describe('sending the e-mails to customers', () => {
  it('sends the welcome from the mailbox of whoever accepted the order, and files it on the order', async () => {
    await mailbox(w.ops.id, 'olly@bluven.example');
    const { orderId } = await orderAt(w, 'ACCEPTED');
    expect(await send()).toEqual({ sent: 1, waiting: 0, stopped: 0 });
    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]).toMatchObject({ account: 'acc_olly@bluven.example', from: 'olly@bluven.example', to: ['jane@example.com'], cc: [], subject: 'Welcome to Bluven: your order BLV-2026-00001', attachments: [] });
    expect(outbox.sent[0]!.html).toContain('Hi Jane,');
    expect(outbox.sent[0]!.html).toContain('Bluven Operations');

    const [notice] = await listNotices(db, orderId);
    expect(notice).toMatchObject({ kind: 'WELCOME', status: 'SENT', sentAt: w.clock.current, note: '' });
    // On the order like any e-mail: in the correspondence and on the timeline, for sales to read as well.
    const mail = await getOrderMail(as(w.sam, w.clock), orderId);
    expect(mail.emails).toEqual([expect.objectContaining({ direction: 'OUT', subject: 'Welcome to Bluven: your order BLV-2026-00001', fromAddress: 'olly@bluven.example', fromName: 'Bluven Operations', to: ['jane@example.com'], sentByName: null })]);
    expect(await db.activity.findFirstOrThrow({ where: { orderId, type: 'EMAIL_OUT' } })).toMatchObject({ summary: 'Email to Jane Smith: Welcome to Bluven: your order BLV-2026-00001', actorId: null, actorLabel: 'Operations e-mail' });
    // It is not the salesperson's work: their clock and their first contact are untouched.
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).firstContactedAt).toBeNull();
    // Nothing is sent twice.
    expect(await send()).toEqual({ sent: 0, waiting: 0, stopped: 0 });
    expect(outbox.sent).toHaveLength(1);
  });

  it('prefers the mailbox chosen for operations, and falls back when that one has to be connected again', async () => {
    const admin = await makeUser(['ADMIN']);
    const shared = await makeUser(['OPS'], 'Operations Desk');
    await mailbox(shared.id, 'operations@bluven.example');
    await mailbox(w.ops.id, 'olly@bluven.example');
    const settings = await getOperationsSettings(db);
    await expect(updateOperationsSettings(as(admin), { ...settings, mailboxUserId: w.sam.id })).rejects.toMatchObject({ fieldErrors: { mailboxUserId: expect.any(String) } });
    await updateOperationsSettings(as(admin), { ...settings, mailboxUserId: shared.id });

    const first = await orderAt(w, 'ACCEPTED');
    await send();
    expect(outbox.sent[0]).toMatchObject({ from: 'operations@bluven.example' });

    await db.emailAccount.update({ where: { userId: shared.id }, data: { needsReconnect: true } });
    await markJobDone(as(w.ops, w.clock), { orderId: first.orderId });
    await send();
    expect(outbox.sent[1]).toMatchObject({ from: 'olly@bluven.example', subject: 'Your Bluven installation is complete' });
  });

  it('sets an e-mail aside, and says why, when there is no mailbox to send it from', async () => {
    const { orderId } = await orderAt(w, 'ACCEPTED');
    expect(await send()).toEqual({ sent: 0, waiting: 0, stopped: 1 });
    const [notice] = await listNotices(db, orderId);
    expect(notice).toMatchObject({ status: 'SKIPPED', note: expect.stringContaining('no mailbox to send it from') });
    // Whoever took the step is told, with a link to the order.
    expect(await db.notification.findFirstOrThrow({ where: { userId: w.ops.id, type: 'mail.notice_failed' } })).toMatchObject({ title: expect.stringContaining('“Welcome” e-mail to the customer was not sent'), href: `/ops/orders/${orderId}` });
    expect(await send()).toEqual({ sent: 0, waiting: 0, stopped: 0 });

    // Once a mailbox is connected, operations sends it again from the order.
    await mailbox(w.ops.id, 'olly@bluven.example');
    await retryNotice(as(w.ops, w.clock), { noticeId: notice!.id });
    expect(await send()).toEqual({ sent: 1, waiting: 0, stopped: 0 });
    expect((await listNotices(db, orderId))[0]).toMatchObject({ status: 'SENT' });
  });

  it('tries again later when the mail service cannot be reached, and gives up after the fourth time', async () => {
    await mailbox(w.ops.id, 'olly@bluven.example');
    const { orderId } = await orderAt(w, 'ACCEPTED');
    outbox.fail = new MailApiError('Zoho Mail answered 503', 503, true);
    expect(await send()).toEqual({ sent: 0, waiting: 1, stopped: 0 });
    expect((await listNotices(db, orderId))[0]).toMatchObject({ status: 'PENDING', note: expect.stringContaining('Trying again in 5 minutes') });
    // Not before its time.
    w.clock.advanceMinutes(4);
    expect(await send()).toEqual({ sent: 0, waiting: 0, stopped: 0 });
    w.clock.advanceMinutes(2);
    expect(await send()).toEqual({ sent: 0, waiting: 1, stopped: 0 });
    w.clock.advanceMinutes(31);
    expect(await send()).toEqual({ sent: 0, waiting: 1, stopped: 0 });
    w.clock.advanceMinutes(181);
    expect(await send()).toEqual({ sent: 0, waiting: 0, stopped: 1 });
    expect((await listNotices(db, orderId))[0]).toMatchObject({ status: 'FAILED', note: expect.stringContaining('four times in a row') });
    expect(await db.notification.count({ where: { userId: w.ops.id, type: 'mail.notice_failed' } })).toBe(1);

    // It can still be sent by hand once the service is back.
    outbox.fail = null;
    await retryNotice(as(w.ops, w.clock), { noticeId: (await listNotices(db, orderId))[0]!.id });
    expect(await send()).toEqual({ sent: 1, waiting: 0, stopped: 0 });
  });

  it('asks for the mailbox to be connected again when the provider has withdrawn our access', async () => {
    await mailbox(w.ops.id, 'olly@bluven.example');
    const { orderId } = await orderAt(w, 'ACCEPTED');
    outbox.fail = new MailApiError('Zoho Mail answered 401 (INVALID_OAUTHTOKEN)', 401, false, true);
    expect(await send()).toEqual({ sent: 0, waiting: 0, stopped: 1 });
    expect((await db.emailAccount.findUniqueOrThrow({ where: { userId: w.ops.id } })).needsReconnect).toBe(true);
    expect((await listNotices(db, orderId))[0]).toMatchObject({ status: 'SKIPPED', note: expect.stringContaining('Connect that mailbox again') });
  });

  it('sends nothing for an order that was cancelled in the meantime', async () => {
    await mailbox(w.ops.id, 'olly@bluven.example');
    const { orderId } = await orderAt(w, 'ACCEPTED');
    await cancelOrder(as(w.ops, w.clock), { orderId, note: 'The roof cannot take the panels.', refundStatus: 'PENDING' });
    expect(await send()).toEqual({ sent: 0, waiting: 0, stopped: 0 });
    expect(outbox.sent).toEqual([]);
    expect((await listNotices(db, orderId))[0]).toMatchObject({ status: 'SKIPPED', note: 'The order was cancelled before this went out.' });
  });

  it('sends the dates when operations says so, with the dates as they stood then', async () => {
    await mailbox(w.ops.id, 'olly@bluven.example');
    const { orderId } = await orderAt(w, 'ACCEPTED');
    const ops = as(w.ops, w.clock);
    await send();
    await updateOpsJob(ops, { orderId, caStatus: 'TODO', caReference: '', stcPlatform: '', stcReference: '', installerName: '', electricianLicence: '', installDate: parseDateOnly('2026-12-12'), deliveryMode: 'PICKUP', deliveryEta: null, purchaseStatus: 'UNDECIDED' });
    await sendScheduleNotice(ops, { orderId });
    // The date moves before the e-mail has gone out: what was written is what is sent, and the order shows that it is out of date.
    await updateOpsJob(ops, { orderId, caStatus: 'TODO', caReference: '', stcPlatform: '', stcReference: '', installerName: '', electricianLicence: '', installDate: parseDateOnly('2026-12-15'), deliveryMode: 'PICKUP', deliveryEta: null, purchaseStatus: 'UNDECIDED' });
    expect(await send()).toEqual({ sent: 1, waiting: 0, stopped: 0 });
    expect(outbox.sent[1]).toMatchObject({ subject: 'Your Bluven installation is booked for 12 Dec 2026' });
    expect(outbox.sent[1]!.html).toContain('Your installer brings the equipment on the day.');
    expect(outbox.sent[1]!.html).toContain('The work will be carried out by one of our accredited installers.');
    // Sent again with the new date, as a second e-mail.
    await sendScheduleNotice(as(w.ops, w.clock), { orderId });
    await send();
    expect(outbox.sent[2]).toMatchObject({ subject: 'Your Bluven installation is booked for 15 Dec 2026' });
    expect((await listNotices(db, orderId)).map((n) => [n.kind, n.status])).toEqual([['SCHEDULE', 'SENT'], ['SCHEDULE', 'SENT'], ['WELCOME', 'SENT']]);
  });

  it('sets everything aside on a server without customer e-mail, for operations to see on the order', async () => {
    const { orderId } = await orderAt(w, 'ACCEPTED');
    expect(await setAsideCustomerNotices(ctx)).toBe(1);
    expect((await listNotices(db, orderId))[0]).toMatchObject({ status: 'SKIPPED', note: expect.stringContaining('Customer e-mail is not set up on this server') });
    expect(await setAsideCustomerNotices(ctx)).toBe(0);
  });
});

describe('a job that has not been opened', () => {
  it('cannot be written to from the CRM', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await mailbox(w.sam.id, 'sam@bluven.example');
    await expect(sendOrderEmail(as(w.sam, w.clock), { orderId, to: ['jane@example.com'], subject: 'Hello', body: 'Hi Jane' }, { apiFor: outbox.api })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Open the job') });
    expect(outbox.sent).toEqual([]);
  });
});

describe('what the assistant is told about a job with operations', () => {
  it('includes what operations has arranged, the job done and the final payment', async () => {
    const { orderId } = await orderAt(w, 'ACCEPTED');
    await updateOpsJob(as(w.ops, w.clock), { orderId, caStatus: 'APPROVED', caReference: 'AUS-1', stcPlatform: 'greendeal', stcReference: '', installerName: 'Joe Volt', electricianLicence: 'EC 1', installDate: parseDateOnly('2026-12-12'), deliveryMode: 'DELIVERY', deliveryEta: parseDateOnly('2026-12-10'), purchaseStatus: 'ORDERED' });
    await markJobDone(as(w.ops, w.clock), { orderId });
    const { text } = await buildOrderContext(db, orderId);
    expect(text).toContain('Stage: Installed, balance due');
    expect(text).toContain('Deposit of $900.00 received (confirmed by operations on 10 Nov 2026).');
    expect(text).toContain('## What operations has arranged\nConnection approval: Approved (AUS-1)\nJob assigned for the certificates: GreenDeal\nInstaller: Joe Volt, licence EC 1\nInstallation date: 12 Dec 2026\nDelivery: Expected on site 10 Dec 2026\nStock: Ordered\nJob done on 10 Nov 2026.');
  });
});
