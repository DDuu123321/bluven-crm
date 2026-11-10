// What happens to the files and tasks of a submission once that submission is taken back:
// a withdrawn or rejected deposit, a removed or replaced contract.
import { readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_DOCUMENT,
  archiveContract,
  cancelOrder,
  createQuote,
  createTask,
  decideDeposit,
  deleteDocument,
  getHandoffChecklist,
  getOrderDocuments,
  getStorage,
  inTx,
  lockOrderForStaff,
  markQuoteSent,
  openDocument,
  parseDateOnly,
  pushOrder,
  reopenDeposit,
  returnOrdersToPool,
  assignOrders,
  setTaskStatus,
  submitDeposit,
  systemCtx,
  updateQuote,
  updateTask,
  upsertPylonQuote,
  voidContract,
  withdrawDeposit,
} from '../src';
import { as, pdf, resetDb, staged, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;
const order = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const currentOf = (orderId: string, key: string) => db.document.findMany({ where: { orderId, type: { key }, ...CURRENT_DOCUMENT }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('submitting the same file again', () => {
  it('accepts the same payment screenshot after a withdrawal', async () => {
    const { orderId, depositId } = await orderAt(w, 'DEPOSIT_PENDING');
    const sam = as(w.sam, w.clock);
    const proof = pdf(`proof ${orderId}`); // byte for byte what was submitted the first time
    await withdrawDeposit(sam, { depositId: depositId! });

    // Typical case: the amount was mistyped, the screenshot is the same.
    const second = await submitDeposit(sam, { orderId, amountCents: 95_000, method: 'BANK_TRANSFER', files: [await staged(proof, 'transfer.pdf')] });
    expect((await order(orderId)).stage).toBe('DEPOSIT_PENDING');

    const current = await currentOf(orderId, 'deposit_proof');
    expect(current).toHaveLength(1);
    expect((await db.deposit.findUniqueOrThrow({ where: { id: second.id } })).proofDocumentId).toBe(current[0]!.id);

    // The first file is still on record and can be opened, it just is not current any more.
    const first = await db.deposit.findUniqueOrThrow({ where: { id: depositId! } });
    const old = await db.document.findUniqueOrThrow({ where: { id: first.proofDocumentId! } });
    expect(old.supersededAt).not.toBeNull();
    expect(old.deletedAt).toBeNull();
    await openDocument(sam, { documentId: old.id, purpose: 'view' });

    const listed = await getOrderDocuments(sam, orderId);
    expect(listed.documents.filter((d) => d.type.key === 'deposit_proof').map((d) => d.id)).toEqual([current[0]!.id]);
    expect(listed.superseded.map((d) => d.id)).toEqual([old.id]);
  });

  it('accepts the same screenshot after finance rejects, and closes the "resubmit" task', async () => {
    const { orderId, depositId } = await orderAt(w, 'DEPOSIT_PENDING');
    await decideDeposit(as(w.fin, w.clock), { depositId: depositId!, decision: 'REJECT', note: 'No matching transfer yet.' });
    expect(await db.task.count({ where: { orderId, kind: 'DEPOSIT_REJECTED', status: 'OPEN' } })).toBe(1);

    w.clock.advanceDays(2);
    await submitDeposit(as(w.sam, w.clock), { orderId, amountCents: 90_000, method: 'BANK_TRANSFER', files: [await staged(pdf(`proof ${orderId}`), 'transfer.pdf')] });
    expect((await order(orderId)).stage).toBe('DEPOSIT_PENDING');
    expect(await currentOf(orderId, 'deposit_proof')).toHaveLength(1);
    // The task the rejection raised is done: it must not sit in the list, overdue, for ever.
    expect(await db.task.findFirstOrThrow({ where: { orderId, kind: 'DEPOSIT_REJECTED' } })).toMatchObject({ status: 'DONE', completedById: w.sam.id });
    // Nothing was left behind in temporary storage.
    expect(readdirSync(`${getStorage().root}/.tmp`)).toEqual([]);
  });

  it('accepts the same signed PDF when a contract is replaced or archived again', async () => {
    const { orderId, quoteId } = await orderAt(w, 'SIGNED');
    const sam = as(w.sam, w.clock);
    const signed = pdf(`contract ${orderId}`);

    // Replace: same file, corrected signing date.
    await archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-08'), files: [await staged(signed, 'signed.pdf')], replaceExisting: true });
    expect(await currentOf(orderId, 'signed_contract')).toHaveLength(1);

    // Remove, then archive the same file once more.
    const live = await db.contract.findFirstOrThrow({ where: { orderId, voidedAt: null } });
    await voidContract(sam, { contractId: live.id, reason: 'Wrong quote version chosen' });
    expect(await currentOf(orderId, 'signed_contract')).toHaveLength(0);
    await archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-08'), files: [await staged(signed, 'signed.pdf')] });

    expect((await order(orderId)).stage).toBe('SIGNED');
    expect(await currentOf(orderId, 'signed_contract')).toHaveLength(1);
    expect(await db.document.count({ where: { orderId, type: { key: 'signed_contract' }, supersededAt: { not: null } } })).toBe(2);
  });

  it('still refuses the same file twice while the first is current', async () => {
    const { orderId } = await orderAt(w, 'SIGNED');
    const sam = as(w.sam, w.clock);
    const file = pdf('one screenshot');
    await expect(submitDeposit(sam, { orderId, amountCents: 90_000, method: 'BANK_TRANSFER', files: [await staged(file, 'a.pdf'), await staged(file, 'b.pdf')] })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('already been uploaded'),
    });
    expect(readdirSync(`${getStorage().root}/.tmp`)).toEqual([]);
  });

  it('keeps set-aside files out of what operations receives', async () => {
    const { orderId, quoteId } = await orderAt(w, 'READY');
    const sam = as(w.sam, w.clock);
    const contract = await db.contract.findFirstOrThrow({ where: { orderId, voidedAt: null } });
    await archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('corrected contract'), 'signed-v2.pdf')], replaceExisting: true });
    expect((await getHandoffChecklist(db, orderId)).complete).toBe(true);

    await pushOrder(sam, { orderId });
    const pkg = await db.handoffPackage.findFirstOrThrow({ where: { orderId } });
    const names = (pkg.snapshot as { documents: { fileName: string }[] }).documents.map((d) => d.fileName);
    expect(names).toContain('signed-v2.pdf');
    expect(names).not.toContain('signed.pdf');
    // Operations sees current files only, and cannot list the set-aside ones.
    const forOps = await getOrderDocuments(as(w.ops), orderId);
    expect(forOps.superseded).toEqual([]);
    expect(forOps.documents.some((d) => d.id === contract.documentId)).toBe(false);
  });
});

describe('contract and deposit files as a record', () => {
  it('never deletes them, whichever page of the submission they are', async () => {
    const { orderId, quoteId } = await orderAt(w, 'QUOTED');
    const sam = as(w.sam, w.clock);
    await archiveContract(sam, { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('page 1'), 'p1.pdf'), await staged(pdf('page 2'), 'p2.pdf')] });
    const pages = await currentOf(orderId, 'signed_contract');
    expect(pages).toHaveLength(2);
    // The second page is not linked to the contract record, and is protected all the same.
    for (const page of pages) {
      await expect(deleteDocument(sam, { documentId: page.id })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('remove the contract') });
    }
    // Also once they are history.
    const contract = await db.contract.findFirstOrThrow({ where: { orderId } });
    await voidContract(sam, { contractId: contract.id, reason: 'Customer signed the wrong version' });
    await expect(deleteDocument(sam, { documentId: pages[0]!.id })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('a contract fixes the quote version it was signed against', () => {
  it('records the version as sent and protects it from later Pylon changes', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const sam = as(w.sam, w.clock);
    const pylon = systemCtx(db, 'Pylon', w.clock.now);
    const design = { pylonDesignId: 'des_1', title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 1_850_000, depositCents: 185_000, currency: 'AUD', webProposalUrl: null };
    const first = await inTx(db, async (tx) => upsertPylonQuote(tx, pylon, await lockOrderForStaff(tx, pylon, orderId), design));

    // Nobody pressed "Mark as sent"; the customer signed and the contract is archived against v1.
    await archiveContract(sam, { orderId, quoteId: first.quoteId, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('signed v1'), 'signed.pdf')] });
    const v1 = await db.quote.findUniqueOrThrow({ where: { id: first.quoteId } });
    expect(v1.sentAt).not.toBeNull();
    expect(v1.isAccepted).toBe(true);
    const o = await order(orderId);
    expect(o.stage).toBe('SIGNED');
    expect(o.quotedAt).not.toBeNull(); // "quoted" never trails "signed" in the figures
    expect(await db.activity.count({ where: { orderId, type: 'QUOTE', summary: { contains: 'recorded as sent' } } })).toBe(1);
    await expect(updateQuote(sam, { quoteId: v1.id, title: 'x', dcWatts: 1, storageWh: null, totalCents: 1, depositCents: null, notes: '' })).rejects.toMatchObject({ code: 'conflict' });

    // The contract is removed and the design changes in Pylon: what was signed stays as it was.
    const contract = await db.contract.findFirstOrThrow({ where: { orderId } });
    await voidContract(sam, { contractId: contract.id, reason: 'Customer wants a smaller system' });
    const second = await inTx(db, async (tx) => upsertPylonQuote(tx, pylon, await lockOrderForStaff(tx, pylon, orderId), { ...design, totalCents: 1_790_000 }));
    expect(second.outcome).toBe('new_version');
    expect((await db.quote.findUniqueOrThrow({ where: { id: v1.id } })).totalCents).toBe(1_850_000);
  });

  it('says so when a version is marked as sent twice, and keeps nothing of the second file', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const sam = as(w.sam, w.clock);
    const quote = await createQuote(sam, { orderId, title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: null, notes: '' });
    await markQuoteSent(sam, { quoteId: quote.id, file: await staged(pdf('as sent'), 'quote.pdf') });
    await expect(markQuoteSent(sam, { quoteId: quote.id, file: await staged(pdf('another file'), 'quote-2.pdf') })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('already marked as sent') });
    expect(readdirSync(`${getStorage().root}/.tmp`)).toEqual([]);
    expect(await currentOf(orderId, 'quote')).toHaveLength(1);
  });
});

describe('a deposit on a cancelled order', () => {
  it('is closed out by finance, not by sales', async () => {
    const { orderId, depositId } = await orderAt(w, 'DEPOSIT_PENDING');
    const sam = as(w.sam, w.clock);
    await cancelOrder(sam, { orderId, note: 'Customer changed their mind', refundStatus: 'PENDING' });

    await expect(withdrawDeposit(sam, { depositId: depositId! })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('cancelled') });
    // Finance records that the money did arrive; nobody is told to push the order.
    await decideDeposit(as(w.fin, w.clock), { depositId: depositId!, decision: 'CONFIRM', receivedAmountCents: 90_000, receivedOn: parseDateOnly('2026-11-10') });
    const deposit = await db.deposit.findUniqueOrThrow({ where: { id: depositId! } });
    expect(deposit.status).toBe('CONFIRMED');
    expect((await order(orderId)).sideState).toBe('CANCELLED');
    const note = await db.notification.findFirstOrThrow({ where: { type: 'deposit.confirmed', userId: w.manager.id } });
    expect(note.title).toContain('cancelled order');
    expect(await db.notification.count({ where: { type: 'deposit.confirmed', body: { contains: 'push the order' } } })).toBe(0);
    // And the confirmation is not something to undo here any more.
    await expect(reopenDeposit(as(w.fin, w.clock), { depositId: depositId!, reason: 'x' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('cancelled') });
  });

  it('can be rejected without sending sales a task to resubmit', async () => {
    const { orderId, depositId } = await orderAt(w, 'DEPOSIT_PENDING');
    await cancelOrder(as(w.sam, w.clock), { orderId, note: 'Customer changed their mind', refundStatus: 'NOT_REQUIRED' });
    await decideDeposit(as(w.fin, w.clock), { depositId: depositId!, decision: 'REJECT', note: 'Nothing arrived.' });
    expect((await db.deposit.findUniqueOrThrow({ where: { id: depositId! } })).status).toBe('REJECTED');
    expect(await db.task.count({ where: { orderId, kind: 'DEPOSIT_REJECTED' } })).toBe(0);
  });
});

describe('the idle clock', () => {
  it('restarts when finance confirms, because waiting for finance does not count', async () => {
    const { orderId, depositId } = await orderAt(w, 'DEPOSIT_PENDING');
    w.clock.advanceDays(11);
    await decideDeposit(as(w.fin, w.clock), { depositId: depositId!, decision: 'CONFIRM', receivedAmountCents: 90_000, receivedOn: parseDateOnly('2026-11-20') });
    const o = await order(orderId);
    expect(o.stage).toBe('DEPOSIT_CONFIRMED');
    expect(o.lastStaffActivityAt.getTime()).toBe(w.clock.current.getTime());
    expect(o.idleLevel).toBe(0);
  });

  it('is not restarted by planning: adding, moving or cancelling a task', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const sam = as(w.sam, w.clock);
    const assignedAt = (await order(orderId)).lastStaffActivityAt.getTime();
    w.clock.advanceDays(3);
    const task = await createTask(sam, { orderId, title: 'Call back', dueAt: new Date('2026-11-20T00:00:00Z') });
    await updateTask(sam, { taskId: task.id, title: 'Call back', dueAt: new Date('2026-12-20T00:00:00Z'), notes: '' });
    await setTaskStatus(sam, { taskId: task.id, status: 'CANCELLED' });
    await setTaskStatus(sam, { taskId: task.id, status: 'OPEN' });
    expect((await order(orderId)).lastStaffActivityAt.getTime()).toBe(assignedAt);
    // Doing the task is work on the order.
    await setTaskStatus(sam, { taskId: task.id, status: 'DONE' });
    expect((await order(orderId)).lastStaffActivityAt.getTime()).toBe(w.clock.current.getTime());
  });
});

describe('tasks after a reassignment', () => {
  it('gives a reopened task to whoever has the order now', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const task = await createTask(as(w.sam, w.clock), { orderId, title: 'Send the brochure', dueAt: new Date('2026-11-12T00:00:00Z') });
    await setTaskStatus(as(w.sam, w.clock), { taskId: task.id, status: 'DONE' });
    const manager = as(w.manager, w.clock);
    await returnOrdersToPool(manager, { orderIds: [orderId], note: 'Sam is on leave' });
    await assignOrders(manager, { orderIds: [orderId], ownerId: w.alex.id });

    await setTaskStatus(manager, { taskId: task.id, status: 'OPEN' });
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(w.alex.id);
    // The former owner has no way to it any more.
    await expect(setTaskStatus(as(w.sam, w.clock), { taskId: task.id, status: 'DONE' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
