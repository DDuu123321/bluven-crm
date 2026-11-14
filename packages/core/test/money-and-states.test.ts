import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptHandoff,
  acceptQuote,
  archiveContract,
  cancelOrder,
  createQuote,
  createGatewayDeposit,
  deleteQuote,
  dismissDuplicateFlag,
  getHandoffChecklist,
  holdOrder,
  inTx,
  listNotices,
  lockOrderForStaff,
  markLost,
  markQuoteSent,
  openJob,
  parseDateOnly,
  pushOrder,
  restoreLost,
  resumeOrder,
  runHoldExpiry,
  setRefundStatus,
  submitDeposit,
  systemCtx,
  updateQuote,
  upsertPylonQuote,
  voidContract,
  withdrawDeposit,
} from '../src';
import { as, leadOrigin, pdf, resetDb, staged, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;
const order = (id: string) => db.order.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('quotes', () => {
  it('keeps sent versions as history', async () => {
    const { orderId, quoteId } = await orderAt(w, 'QUOTED');
    const sam = as(w.sam, w.clock);
    await expect(updateQuote(sam, { quoteId: quoteId!, title: 'x', dcWatts: 5000, storageWh: null, totalCents: 800_000, depositCents: null, notes: '' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(deleteQuote(sam, { quoteId: quoteId! })).rejects.toMatchObject({ code: 'conflict' });
    const v2 = await createQuote(sam, { orderId, title: 'cheaper', dcWatts: 5000, storageWh: null, totalCents: 800_000, depositCents: 80_000, notes: '' });
    expect(v2.version).toBe(2);
    await updateQuote(sam, { quoteId: v2.id, title: 'cheaper still', dcWatts: 5000, storageWh: null, totalCents: 780_000, depositCents: 78_000, notes: '' });
    expect((await db.quote.findUniqueOrThrow({ where: { id: v2.id } })).totalCents).toBe(780_000);
    await deleteQuote(sam, { quoteId: v2.id });
    expect(await db.quote.count({ where: { orderId } })).toBe(1);
  });

  it('validates the figures', async () => {
    const { orderId } = await orderAt(w, 'OPENED');
    const sam = as(w.sam, w.clock);
    await expect(createQuote(sam, { orderId, title: '', dcWatts: null, storageWh: null, totalCents: null, depositCents: null, notes: '' })).rejects.toMatchObject({
      fieldErrors: { total: expect.any(String), systemKw: expect.any(String) },
    });
    await expect(createQuote(sam, { orderId, title: '', dcWatts: 6600, storageWh: null, totalCents: 100_000, depositCents: 200_000, notes: '' })).rejects.toMatchObject({
      fieldErrors: { deposit: expect.any(String) },
    });
  });

  it('records Pylon designs as versions: the first one says that the design has started', async () => {
    const { orderId } = await orderAt(w, 'OPENED');
    const pylon = systemCtx(db, 'Pylon', w.clock.now);
    const data = { pylonDesignId: 'des_1', title: 'Design A', dcWatts: 6600, storageWh: 10000, totalCents: 1_500_000, depositCents: 150_000, currency: 'AUD', webProposalUrl: 'https://app.getpylon.com/p/abc' };
    const run = (d = data) => inTx(db, async (tx) => upsertPylonQuote(tx, pylon, await lockOrderForStaff(tx, pylon, orderId), d));

    expect((await order(orderId)).stage).toBe('FOLLOW_UP');
    expect((await run()).outcome).toBe('created');
    expect((await order(orderId)).stage).toBe('DESIGN');
    expect((await run()).outcome).toBe('unchanged');
    // Not sent yet: a changed design updates the same version.
    expect((await run({ ...data, totalCents: 1_450_000 })).outcome).toBe('updated');
    expect(await db.quote.count({ where: { orderId } })).toBe(1);

    // Once sent, changed figures become a new version and the sent one is preserved.
    const v1 = await db.quote.findFirstOrThrow({ where: { orderId } });
    await markQuoteSent(as(w.sam, w.clock), { quoteId: v1.id });
    expect((await order(orderId)).stage).toBe('PROPOSAL_SENT');
    expect((await run({ ...data, totalCents: 1_450_000 })).outcome).toBe('unchanged');
    expect((await run({ ...data, totalCents: 1_400_000 })).outcome).toBe('new_version');
    const versions = await db.quote.findMany({ where: { orderId }, orderBy: { version: 'asc' } });
    expect(versions.map((q) => [q.version, q.totalCents, !!q.sentAt])).toEqual([[1, 1_450_000, true], [2, 1_400_000, false]]);
  });
});

describe('a job that has not been opened', () => {
  it('takes in what Pylon sends and stays a new lead until someone opens it', async () => {
    // Pylon knows an order by its number, so a design can arrive before the salesperson has taken the job up.
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const pylon = systemCtx(db, 'Pylon', w.clock.now);
    await inTx(db, async (tx) => upsertPylonQuote(tx, pylon, await lockOrderForStaff(tx, pylon, orderId), { pylonDesignId: 'des_9', title: 'Design', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, currency: 'AUD', webProposalUrl: null }));
    expect(await db.quote.count({ where: { orderId } })).toBe(1);
    expect(await order(orderId)).toMatchObject({ stage: 'NEW', openedAt: null });
    // Opening it puts the order where its facts say.
    await openJob(as(w.sam, w.clock), { orderId, leadOriginId: (await leadOrigin('customer_referral')).id });
    expect((await order(orderId)).stage).toBe('DESIGN');
  });

  it('can be closed as lost, and its details can be corrected, without opening it', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'invalid_contact' } });
    await markLost(as(w.sam, w.clock), { orderId, reasonId: reason.id, note: 'The number is not in service.' });
    expect(await order(orderId)).toMatchObject({ sideState: 'LOST', stage: 'NEW' });
    await expect(openJob(as(w.sam, w.clock), { orderId, leadOriginId: (await leadOrigin('other')).id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('is opened with a lead source that is in use', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const retired = await db.leadOrigin.update({ where: { key: 'advertising' }, data: { isActive: false } });
    await expect(openJob(as(w.sam, w.clock), { orderId, leadOriginId: retired.id })).rejects.toMatchObject({ fieldErrors: { leadOriginId: expect.any(String) } });
    await expect(openJob(as(w.sam, w.clock), { orderId, leadOriginId: (await leadOrigin('other')).id, note: 'x'.repeat(201) })).rejects.toMatchObject({ fieldErrors: { leadOriginNote: expect.any(String) } });
    expect((await order(orderId)).openedAt).toBeNull();
  });
});

describe('contracts', () => {
  it('requires a quote, a past date and a file', async () => {
    const { orderId, quoteId } = await orderAt(w, 'QUOTED');
    const sam = as(w.sam, w.clock);
    await expect(archiveContract(sam, { orderId, quoteId: null, signedOn: null, files: [] })).rejects.toMatchObject({
      fieldErrors: { files: expect.any(String), signedOn: expect.any(String), quoteId: expect.any(String) },
    });
    await expect(archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2027-01-01'), files: [await staged(pdf('c'), 'c.pdf')] })).rejects.toMatchObject({
      fieldErrors: { signedOn: expect.stringContaining('future') },
    });
  });

  it('allows one live contract; replacing voids the old one', async () => {
    const { orderId, quoteId } = await orderAt(w, 'QUOTED');
    const sam = as(w.sam, w.clock);
    await archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('first'), 'c1.pdf')] });
    await expect(archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('second'), 'c2.pdf')] })).rejects.toMatchObject({ code: 'conflict' });
    await archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-10'), files: [await staged(pdf('second'), 'c2.pdf')], replaceExisting: true });
    const contracts = await db.contract.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
    expect(contracts.map((c) => !!c.voidedAt)).toEqual([true, false]);
  });

  it('is a file for the folder, not a step: filing or removing one leaves the stage where it is', async () => {
    const { orderId, quoteId } = await orderAt(w, 'QUOTED');
    await archiveContract(as(w.sam, w.clock), { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('signed'), 'signed.pdf')] });
    let o = await order(orderId);
    expect(o.stage).toBe('PROPOSAL_SENT');
    expect(o.signedAt).not.toBeNull();
    // What it does say is which version the customer accepted.
    expect(await db.quote.count({ where: { orderId, isAccepted: true } })).toBe(1);
    const contract = await db.contract.findFirstOrThrow({ where: { orderId } });
    await voidContract(as(w.sam, w.clock), { contractId: contract.id, reason: 'Wrong file' });
    o = await order(orderId);
    expect(o.stage).toBe('PROPOSAL_SENT');
    expect(o.signedAt).toBeNull();
    expect(await db.quote.count({ where: { orderId, isAccepted: true } })).toBe(0);
    // An order is pushed without one.
    expect((await getHandoffChecklist(db, orderId)).items.map((i) => i.key)).not.toContain('contract');
  });

  it('leaves the accepted version alone when it is removed after the deposit', async () => {
    const { orderId, quoteId } = await orderAt(w, 'DEPOSIT_PAID');
    const sam = as(w.sam, w.clock);
    await archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('signed'), 'signed.pdf')] });
    const contract = await db.contract.findFirstOrThrow({ where: { orderId } });
    await voidContract(sam, { contractId: contract.id, reason: 'Wrong file' });
    // The deposit was recorded for this version, and that still holds.
    expect(await db.quote.findMany({ where: { orderId, isAccepted: true }, select: { id: true } })).toEqual([{ id: quoteId }]);
    expect((await order(orderId)).stage).toBe('DEPOSIT_PAID');
    expect((await getHandoffChecklist(db, orderId)).items.find((i) => i.key === 'quote')).toMatchObject({ ok: true });
  });
});

describe('deposits', () => {
  it('needs no contract, and says which proposal the customer went ahead with', async () => {
    const { orderId, quoteId } = await orderAt(w, 'QUOTED');
    const sam = as(w.sam, w.clock);
    const proof = async (label: string) => [await staged(pdf(label), 'transfer.pdf')];
    await expect(submitDeposit(sam, { orderId, amountCents: null, method: 'CASH', files: [] })).rejects.toMatchObject({
      fieldErrors: { amount: expect.any(String), method: expect.any(String), files: expect.any(String) },
    });
    // With one version there is nothing to ask. With two, the salesperson says which.
    const v2 = await createQuote(sam, { orderId, title: 'with battery', dcWatts: 6600, storageWh: 10000, totalCents: 1_700_000, depositCents: 170_000, notes: '' });
    await expect(submitDeposit(sam, { orderId, amountCents: 170_000, method: 'BANK_TRANSFER', files: await proof('a') })).rejects.toMatchObject({ fieldErrors: { quoteId: expect.any(String) } });
    await expect(submitDeposit(sam, { orderId, amountCents: 170_000, method: 'BANK_TRANSFER', quoteId: 'quo_of_another_order', files: await proof('b') })).rejects.toMatchObject({ fieldErrors: { quoteId: expect.any(String) } });
    await submitDeposit(sam, { orderId, amountCents: 170_000, method: 'BANK_TRANSFER', quoteId: v2.id, files: await proof('c') });
    const o = await order(orderId);
    expect(o.stage).toBe('DEPOSIT_PAID');
    expect(o.depositAt?.toISOString()).toBe(w.clock.current.toISOString());
    expect((await db.quote.findMany({ where: { orderId }, orderBy: { version: 'asc' } })).map((q) => q.isAccepted)).toEqual([false, true]);
    // The choice can be corrected for as long as the order is with sales.
    await acceptQuote(sam, { quoteId: quoteId! });
    expect((await db.quote.findMany({ where: { orderId }, orderBy: { version: 'asc' } })).map((q) => q.isAccepted)).toEqual([true, false]);
    await expect(acceptQuote(as(w.alex, w.clock), { quoteId: v2.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets sales withdraw a record that was wrong, but not file two, and not once operations has confirmed it', async () => {
    const { orderId, depositId } = await orderAt(w, 'DEPOSIT_PAID');
    const sam = as(w.sam, w.clock);
    await expect(submitDeposit(sam, { orderId, amountCents: 1, method: 'BANK_TRANSFER', files: [await staged(pdf('x'), 'x.pdf')] })).rejects.toMatchObject({ code: 'conflict' });
    await withdrawDeposit(sam, { depositId: depositId! });
    expect(await order(orderId)).toMatchObject({ stage: 'PROPOSAL_SENT', depositAt: null });
    // The proof goes with it: the checklist is open again.
    expect((await getHandoffChecklist(db, orderId)).items.find((i) => i.key === 'deposit')).toMatchObject({ ok: false });

    const confirmed = await orderAt(w, 'ACCEPTED', { phone: '0400 000 002', email: 'three@example.com', address: '3 Three St' });
    await expect(withdrawDeposit(sam, { depositId: confirmed.depositId! })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('takes a payment through the Pylon gateway as the deposit, once', async () => {
    const { orderId } = await orderAt(w, 'QUOTED');
    const pylon = systemCtx(db, 'Pylon', w.clock.now);
    const pay = () => inTx(db, async (tx) => createGatewayDeposit(tx, pylon, await lockOrderForStaff(tx, pylon, orderId), { amountCents: 90_000, currency: 'AUD', receiptUrl: 'https://pay.example/r/1', pylonEventId: 'evt_1' }));
    expect(await pay()).toBe('created');
    expect(await pay()).toBe('already_recorded');
    expect((await order(orderId)).stage).toBe('DEPOSIT_PAID');
    const deposit = await db.deposit.findFirstOrThrow({ where: { orderId } });
    expect(deposit).toMatchObject({ method: 'GATEWAY', status: 'PENDING', receiptUrl: 'https://pay.example/r/1' });
    // The receipt stands in for the screenshot, and the salesperson hears about it. Finance does not, yet.
    expect((await getHandoffChecklist(db, orderId)).items.find((i) => i.key === 'deposit')).toMatchObject({ ok: true, detail: expect.stringContaining('paid through Pylon') });
    expect(await db.notification.count({ where: { userId: w.sam.id, type: 'deposit.gateway' } })).toBe(1);
    expect(await db.notification.count({ where: { userId: w.fin.id } })).toBe(0);
  });

  it('asks for the proposal file before the order can be pushed', async () => {
    const { orderId } = await orderAt(w, 'OPENED');
    const sam = as(w.sam, w.clock);
    const bare = await createQuote(sam, { orderId, title: 'no file', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, notes: '' });
    await markQuoteSent(sam, { quoteId: bare.id });
    await submitDeposit(sam, { orderId, amountCents: 90_000, method: 'BANK_TRANSFER', files: [await staged(pdf('proof'), 'p.pdf')] });
    expect((await getHandoffChecklist(db, orderId)).items.find((i) => i.key === 'quote')).toMatchObject({ ok: false, detail: expect.stringContaining('has no file yet') });
  });
});

describe('lost, on hold and cancelled', () => {
  it('marks an order lost with a reason and lets only a manager restore it', async () => {
    const { orderId } = await orderAt(w, 'QUOTED');
    const sam = as(w.sam, w.clock);
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'competitor' } });
    await expect(markLost(sam, { orderId, reasonId: 'nope' })).rejects.toMatchObject({ fieldErrors: { reasonId: expect.any(String) } });
    await markLost(sam, { orderId, reasonId: reason.id, note: 'Went with a cheaper installer.' });
    let o = await order(orderId);
    expect(o).toMatchObject({ sideState: 'LOST', stage: 'PROPOSAL_SENT', lostReasonId: reason.id, lostNote: 'Went with a cheaper installer.' });
    // Read-only now.
    await expect(createQuote(sam, { orderId, title: '', dcWatts: 5000, storageWh: null, totalCents: 1, depositCents: null, notes: '' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(restoreLost(sam, { orderId })).rejects.toMatchObject({ code: 'forbidden' });
    await restoreLost(as(w.manager, w.clock), { orderId });
    o = await order(orderId);
    expect(o).toMatchObject({ sideState: 'NONE', stage: 'PROPOSAL_SENT', lostReasonId: null });
  });

  it('uses lost before a deposit and cancelled after one', async () => {
    const before = await orderAt(w, 'QUOTED');
    const sam = as(w.sam, w.clock);
    await expect(cancelOrder(sam, { orderId: before.orderId, note: 'changed mind', refundStatus: 'NOT_REQUIRED' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('lost') });

    const after = await orderAt(w, 'DEPOSIT_PAID', { phone: '0400 000 001', email: 'two@example.com', address: '2 Two St' });
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await expect(markLost(sam, { orderId: after.orderId, reasonId: reason.id })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Cancel') });
    await expect(cancelOrder(sam, { orderId: after.orderId, note: '', refundStatus: 'x' })).rejects.toMatchObject({ fieldErrors: { note: expect.any(String), refundStatus: expect.any(String) } });
    await cancelOrder(sam, { orderId: after.orderId, note: 'Customer is selling the house.', refundStatus: 'PENDING' });
    expect(await order(after.orderId)).toMatchObject({ sideState: 'CANCELLED', refundStatus: 'PENDING' });
    expect(await db.notification.count({ where: { userId: w.fin.id, type: 'refund.pending' } })).toBe(1);

    await expect(setRefundStatus(sam, { orderId: after.orderId, refundStatus: 'REFUNDED' })).rejects.toMatchObject({ code: 'forbidden' });
    await setRefundStatus(as(w.fin, w.clock), { orderId: after.orderId, refundStatus: 'REFUNDED' });
    expect((await order(after.orderId)).refundStatus).toBe('REFUNDED');
  });

  it('withdraws the order from the operations inbox when it is cancelled after a push', async () => {
    const { orderId } = await orderAt(w, 'READY');
    await pushOrder(as(w.sam, w.clock), { orderId });
    await cancelOrder(as(w.sam, w.clock), { orderId, note: 'Customer pulled out.', refundStatus: 'PENDING' });
    expect(await order(orderId)).toMatchObject({ sideState: 'CANCELLED', stage: 'DEPOSIT_PAID' });
    expect((await db.handoffPackage.findFirstOrThrow({ where: { orderId } })).decision).toBe('WITHDRAWN');
    expect(await db.notification.count({ where: { userId: w.ops.id, type: 'handoff.withdrawn' } })).toBe(1);
    // A cancelled order is not accepted.
    await expect(acceptHandoff(as(w.ops, w.clock), { orderId, depositReceived: true })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('is cancelled by operations or a manager once operations has accepted it, until the installation is done', async () => {
    const { orderId } = await orderAt(w, 'ACCEPTED');
    expect((await listNotices(db, orderId)).map((n) => [n.kind, n.status])).toEqual([['WELCOME', 'PENDING']]);
    const cancel = { orderId, note: 'The roof cannot take the panels.', refundStatus: 'PENDING' };
    await expect(cancelOrder(as(w.sam, w.clock), cancel)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(cancelOrder(as(w.fin, w.clock), cancel)).rejects.toMatchObject({ code: 'forbidden' });
    await cancelOrder(as(w.ops, w.clock), cancel);
    expect(await order(orderId)).toMatchObject({ sideState: 'CANCELLED', stage: 'IN_PROGRESS', refundStatus: 'PENDING' });
    // The salesperson and the managers are told, and nothing more goes to the customer by itself.
    expect(await db.notification.count({ where: { type: 'order.cancelled', userId: { in: [w.sam.id, w.manager.id] } } })).toBe(2);
    expect(await db.notification.count({ where: { userId: w.fin.id, type: 'refund.pending' } })).toBe(1);
    expect((await listNotices(db, orderId)).map((n) => n.status)).toEqual(['SKIPPED']);

    const done = await orderAt(w, 'INSTALLED', { phone: '0400 000 003', email: 'four@example.com', address: '4 Four St' });
    await expect(cancelOrder(as(w.manager, w.clock), { ...cancel, orderId: done.orderId })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('installation is done') });
  });

  it('puts an order on hold until a date and resumes it automatically', async () => {
    const { orderId } = await orderAt(w, 'QUOTED');
    const sam = as(w.sam, w.clock);
    await expect(holdOrder(sam, { orderId, until: null })).rejects.toMatchObject({ fieldErrors: { until: expect.any(String) } });
    await expect(holdOrder(sam, { orderId, until: parseDateOnly('2026-11-10') })).rejects.toMatchObject({ fieldErrors: { until: 'Choose a date after today.' } });
    await holdOrder(sam, { orderId, until: parseDateOnly('2026-11-20'), note: 'Back from holiday on the 20th.' });
    expect(await order(orderId)).toMatchObject({ sideState: 'ON_HOLD', stage: 'PROPOSAL_SENT' });
    await expect(pushOrder(sam, { orderId })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('hold') });

    // The day before: nothing happens.
    w.clock.current = new Date('2026-11-18T22:00:00Z'); // 19 Nov, 9 am in Sydney
    expect(await runHoldExpiry(systemCtx(db, 'System', w.clock.now))).toEqual({ resumed: 0 });
    // On the day (Sydney time): resumed, with a task and a notification.
    w.clock.current = new Date('2026-11-19T14:00:00Z'); // 20 Nov, 1 am in Sydney
    expect(await runHoldExpiry(systemCtx(db, 'System', w.clock.now))).toEqual({ resumed: 1 });
    const o = await order(orderId);
    expect(o).toMatchObject({ sideState: 'NONE', onHoldUntil: null, idleLevel: 0 });
    expect(o.lastStaffActivityAt.toISOString()).toBe('2026-11-19T14:00:00.000Z');
    expect(await db.task.findFirstOrThrow({ where: { orderId, kind: 'HOLD_ENDED' } })).toMatchObject({ assigneeId: w.sam.id, status: 'OPEN' });
    expect(await db.notification.count({ where: { userId: w.sam.id, type: 'order.hold_ended' } })).toBe(1);
    expect(await runHoldExpiry(systemCtx(db, 'System', w.clock.now))).toEqual({ resumed: 0 });
  });

  it('can be resumed by hand', async () => {
    const { orderId } = await orderAt(w, 'OPENED');
    await holdOrder(as(w.sam, w.clock), { orderId, until: parseDateOnly('2026-12-01') });
    await resumeOrder(as(w.sam, w.clock), { orderId });
    expect((await order(orderId)).sideState).toBe('NONE');
    await expect(resumeOrder(as(w.sam, w.clock), { orderId })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets a manager dismiss a possible-duplicate flag', async () => {
    const first = await orderAt(w, 'NEW');
    const second = await orderAt(w, 'NEW', { firstName: 'John', phone: '0499 111 222', email: 'john@example.com' });
    expect((await order(second.orderId)).possibleDuplicateOfId).toBe(first.orderId);
    await expect(dismissDuplicateFlag(as(w.sam, w.clock), { orderId: second.orderId })).rejects.toMatchObject({ code: 'forbidden' });
    await dismissDuplicateFlag(as(w.manager, w.clock), { orderId: second.orderId });
    expect((await order(second.orderId)).duplicateDismissedAt).not.toBeNull();
  });
});
