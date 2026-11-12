// Document retention: two years from the day an order ended, a reminder before the end, a human
// decision (or, only when an admin says so, automatic deletion), and the purge of deleted files.
import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptHandoff,
  addYears,
  cancelOrder,
  createQuote,
  deleteDocument,
  deleteExpiringDocuments,
  formatDate,
  getConfig,
  getOrderDocuments,
  getOrderRetention,
  getSettings,
  getStorage,
  keepDocumentsAnotherYear,
  listRetentionOrders,
  listReusableDocuments,
  markLost,
  markQuoteSent,
  moveOrderToNewProperty,
  nextRetentionStep,
  openDocument,
  pushOrder,
  restoreLost,
  retentionAwaitingCount,
  reuseDocuments,
  runDocumentRetention,
  systemCtx,
  updateSettings,
  uploadDocument,
  type RetentionSettings,
} from '../src';
import { as, docType, makeUser, pdf, png, resetDb, staged, stream, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;

const DAY = 86_400_000;
const NOTHING = { reminders: 0, repeatReminders: 0, deleted: 0, purged: 0, filesRemoved: 0 };

const job = () => runDocumentRetention(systemCtx(db, 'System', w.clock.now));
const at = (date: Date): void => {
  w.clock.current = date;
};
const daysBefore = (date: Date, days: number) => new Date(date.getTime() - days * DAY);
const daysAfter = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
const day = (date: Date) => formatDate(date, getConfig().timeZone);
const order = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const notes = (userId: string, type: string) => db.notification.findMany({ where: { userId, type }, orderBy: { createdAt: 'asc' } });
const onDisk = (key: string | null) => !!key && existsSync(getStorage().absolutePath(key));

async function upload(orderId: string, key: string, name: string, body: Buffer) {
  return uploadDocument(as(w.sam, w.clock), { orderId, typeId: (await docType(key)).id, fileName: name, body: stream(body) });
}

async function lose(orderId: string): Promise<Date> {
  const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
  await markLost(as(w.sam, w.clock), { orderId, reasonId: reason.id });
  return w.clock.current;
}

async function setRetention(change: Partial<RetentionSettings>): Promise<void> {
  const admin = await makeUser(['ADMIN']);
  const current = await getSettings(db);
  await updateSettings(as(admin, w.clock), { ...current, retention: { ...current.retention, ...change } });
}

/** A lost order of Sam's with one bill, and the end of the bill's retention period. */
async function lostOrderWithBill(over: Record<string, unknown> = {}): Promise<{ orderId: string; billId: string; deadline: Date }> {
  const { orderId } = await orderAt(w, 'ASSIGNED', over);
  const bill = await upload(orderId, 'electricity_bill', 'bill.pdf', pdf(`bill ${orderId}`));
  const lostAt = await lose(orderId);
  return { orderId, billId: bill.id, deadline: addYears(lostAt, 2) };
}

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('the retention period', () => {
  it('lets nothing expire while an order is open, and runs for two years from the day it ended', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await upload(orderId, 'electricity_bill', 'bill.pdf', pdf('bill'));
    // Open for more than three years: still nothing to decide.
    w.clock.advanceDays(1200);
    expect(await job()).toEqual(NOTHING);
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'OPEN', deadline: null, expiring: [] });

    const lostAt = await lose(orderId);
    const deadline = addYears(lostAt, 2);
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'KEPT', endedAt: lostAt, deadline, retained: 1, expiring: [] });

    // 31 days before the end nobody is bothered yet; 30 days before, the salesperson and the managers are told.
    at(daysBefore(deadline, 31));
    expect(await job()).toEqual(NOTHING);
    expect(await retentionAwaitingCount(db, w.clock.current)).toBe(0);
    at(daysBefore(deadline, 30));
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });

    for (const person of [w.sam, w.manager]) {
      const [reminder, ...more] = await notes(person.id, 'retention.reminder');
      expect(more).toEqual([]);
      expect(reminder!.title).toMatch(new RegExp(`^BLV-\\d{4}-\\d{5}: 1 document reaches the end of its retention period on ${day(deadline)}$`));
      expect(reminder!.body).toContain('Jane Smith, lost on');
      expect(reminder!.body).toContain('Keep it for another year, or delete it. Nothing is deleted until someone decides.');
      expect(reminder).toMatchObject({ href: `/orders/${orderId}?tab=documents#retention`, orderId });
    }
    // Nobody else hears about it.
    expect(await db.notification.count({ where: { type: 'retention.reminder' } })).toBe(2);
    expect(await order(orderId)).toMatchObject({ retentionRemindedFor: deadline, retentionRemindedAt: w.clock.current });
    expect(await db.auditLog.count({ where: { orderId, action: 'retention.reminder' } })).toBe(1);

    // Once per order per period, however often the job runs.
    w.clock.advanceDays(3);
    expect(await job()).toEqual(NOTHING);
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'DUE', deadline, expiring: [{ fileName: 'bill.pdf', typeLabel: 'Electricity bill', deadline }], autoDeleteAt: null });
    expect(await retentionAwaitingCount(db, w.clock.current)).toBe(1);
  });

  it('starts from the handover for a finished order and from the cancellation for a cancelled one', async () => {
    const done = await orderAt(w, 'READY');
    await pushOrder(as(w.sam, w.clock), { orderId: done.orderId });
    w.clock.advanceDays(2);
    await acceptHandoff(as(w.ops, w.clock), { orderId: done.orderId });
    const handedOverAt = w.clock.current;

    const cancelled = await orderAt(w, 'DEPOSIT_PENDING', { phone: '0400 555 666', email: 'second@example.com', address: '2 Other Rd' });
    await upload(cancelled.orderId, 'electricity_bill', 'bill.pdf', pdf('second bill'));
    w.clock.advanceDays(10);
    await cancelOrder(as(w.sam, w.clock), { orderId: cancelled.orderId, note: 'Changed their mind.', refundStatus: 'PENDING' });
    const cancelledAt = w.clock.current;

    // The bill and the two site photos are under retention; the contract and the deposit proof are not.
    const first = await getOrderRetention(as(w.manager, w.clock), done.orderId);
    expect(first).toMatchObject({ status: 'KEPT', endedAt: handedOverAt, deadline: addYears(handedOverAt, 2), retained: 3 });
    const second = await getOrderRetention(as(w.manager, w.clock), cancelled.orderId);
    expect(second).toMatchObject({ status: 'KEPT', endedAt: cancelledAt, deadline: addYears(cancelledAt, 2), retained: 1 });

    // Operations and finance can open the orders but take no part in retention.
    expect(await getOrderRetention(as(w.ops, w.clock), done.orderId)).toBeNull();
    expect(await getOrderRetention(as(w.fin, w.clock), cancelled.orderId)).toBeNull();
    await expect(getOrderRetention(as(w.alex, w.clock), done.orderId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never touches contract and deposit files, or types an admin marked as never deleted', async () => {
    const { orderId } = await orderAt(w, 'DEPOSIT_PENDING');
    await upload(orderId, 'electricity_bill', 'bill.pdf', pdf('bill'));
    await upload(orderId, 'other', 'compliance.pdf', pdf('compliance'));
    await db.documentType.update({ where: { key: 'other' }, data: { neverAutoDelete: true } });
    // Even if somebody unticks the box on the built-in types, what was signed and paid stays.
    await db.documentType.updateMany({ where: { key: { in: ['signed_contract', 'deposit_proof'] } }, data: { neverAutoDelete: false } });
    await cancelOrder(as(w.sam, w.clock), { orderId, note: 'Moved house.', refundStatus: 'NOT_REQUIRED' });
    const deadline = addYears(w.clock.current, 2);

    at(daysAfter(deadline, 1));
    expect(await job()).toMatchObject({ reminders: 1 });
    const state = await getOrderRetention(as(w.sam, w.clock), orderId);
    expect(state!.expiring.map((d) => d.fileName)).toEqual(['bill.pdf']);
    expect(await deleteExpiringDocuments(as(w.sam, w.clock), { orderId })).toEqual({ deleted: 1 });

    const left = await db.document.findMany({ where: { orderId, deletedAt: null }, select: { fileName: true }, orderBy: { fileName: 'asc' } });
    expect(left.map((d) => d.fileName)).toEqual(['compliance.pdf', 'signed.pdf', 'transfer.pdf']);
    // Nothing left to decide, now or ever.
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'NONE', expiring: [] });
    w.clock.advanceDays(4000);
    expect(await job()).toMatchObject({ reminders: 0, deleted: 0 });
    expect(await db.document.count({ where: { orderId, deletedAt: null } })).toBe(3);
  });

  it('gives a document type its own period when an admin sets one, and the standard period otherwise', async () => {
    // The built-in types carry no period of their own, so the setting governs them.
    expect((await docType('electricity_bill')).retentionYears).toBeNull();
    await db.documentType.update({ where: { key: 'other' }, data: { retentionYears: 5 } });
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await upload(orderId, 'electricity_bill', 'bill.pdf', pdf('bill'));
    await upload(orderId, 'other', 'warranty.pdf', pdf('warranty'));
    const lostAt = await lose(orderId);
    const deadline = addYears(lostAt, 2);

    at(daysBefore(deadline, 5));
    expect(await job()).toMatchObject({ reminders: 1 });
    expect((await getOrderRetention(as(w.sam, w.clock), orderId))!.expiring.map((d) => d.fileName)).toEqual(['bill.pdf']);
    expect(await deleteExpiringDocuments(as(w.sam, w.clock), { orderId })).toEqual({ deleted: 1 });
    // The warranty paper has three more years; the order drops off the list until then.
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'KEPT', deadline: addYears(lostAt, 5), retained: 1 });
    // Nearly three years on, the only thing left to do is to remove the file of the bill that was deleted then.
    at(daysBefore(addYears(lostAt, 5), 31));
    expect(await job()).toEqual({ ...NOTHING, purged: 1, filesRemoved: 1 });
    at(daysBefore(addYears(lostAt, 5), 29));
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });
    expect(await notes(w.sam.id, 'retention.reminder')).toHaveLength(2);
  });

  it('agrees with the calendar on a leap day', async () => {
    await setRetention({ years: 1 });
    at(new Date('2028-02-29T03:00:00Z'));
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await upload(orderId, 'electricity_bill', 'bill.pdf', pdf('bill'));
    await lose(orderId);
    // A year after 29 February is 28 February; the list, the job and the page all read the same date.
    const state = await getOrderRetention(as(w.sam, w.clock), orderId);
    expect(state!.deadline).toEqual(new Date('2029-02-28T03:00:00Z'));
    expect(state!.deadline).toEqual(addYears(new Date('2028-02-29T03:00:00Z'), 1));
    at(new Date('2029-02-01T00:00:00Z'));
    expect(await job()).toMatchObject({ reminders: 1 });
    expect((await order(orderId)).retentionRemindedFor).toEqual(new Date('2029-02-28T03:00:00Z'));
  });

  it('forgets the period when a lost order is restored, and starts a new one when it ends again', async () => {
    const { orderId, deadline } = await lostOrderWithBill();
    at(daysBefore(deadline, 10));
    expect(await job()).toMatchObject({ reminders: 1 });
    await restoreLost(as(w.manager, w.clock), { orderId });
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'OPEN' });
    expect((await listRetentionOrders(as(w.manager, w.clock))).rows).toEqual([]);
    await expect(keepDocumentsAnotherYear(as(w.sam, w.clock), { orderId })).rejects.toMatchObject({ code: 'conflict' });
    w.clock.advanceDays(400);
    expect(await job()).toEqual(NOTHING);

    const lostAgain = await lose(orderId);
    at(daysBefore(addYears(lostAgain, 2), 30));
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });
    expect(await notes(w.sam.id, 'retention.reminder')).toHaveLength(2);
  });
});

describe('the decision', () => {
  it('keeps the documents for another year, and asks again when that year is nearly over', async () => {
    const { orderId, billId, deadline } = await lostOrderWithBill();
    at(daysBefore(deadline, 30));
    await job();
    w.clock.advanceDays(12);

    // Not somebody else's order, and not for operations or finance.
    await expect(keepDocumentsAnotherYear(as(w.alex, w.clock), { orderId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(keepDocumentsAnotherYear(as(w.ops, w.clock), { orderId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteExpiringDocuments(as(w.fin, w.clock), { orderId })).rejects.toMatchObject({ code: 'not_found' });

    const kept = await keepDocumentsAnotherYear(as(w.sam, w.clock), { orderId });
    expect(kept).toEqual({ keptUntil: addYears(deadline, 1), documents: 1 });
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'KEPT', deadline: addYears(deadline, 1), expiring: [] });
    expect((await db.document.findUniqueOrThrow({ where: { id: billId } })).deletedAt).toBeNull();
    expect(await retentionAwaitingCount(db, w.clock.current)).toBe(0);
    // Choosing twice does not add a second year.
    await expect(keepDocumentsAnotherYear(as(w.sam, w.clock), { orderId })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('close to the end of its retention period') });

    const log = await db.auditLog.findFirstOrThrow({ where: { orderId, action: 'retention.extend' } });
    expect(log).toMatchObject({ actorId: w.sam.id, entityType: 'Order', entityId: orderId });
    expect(log.summary).toContain(`kept 1 document for another year, until ${day(addYears(deadline, 1))}`);
    const entry = await db.activity.findFirstOrThrow({ where: { orderId, type: 'DOCUMENT' }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] });
    expect(entry.summary).toBe(`Kept 1 document for another year, until ${day(addYears(deadline, 1))}`);

    // The original end date passes quietly. A month before the new one, the question comes back.
    at(daysAfter(deadline, 40));
    expect(await job()).toEqual(NOTHING);
    at(daysBefore(addYears(deadline, 1), 30));
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });
    expect(await notes(w.sam.id, 'retention.reminder')).toHaveLength(2);
    expect(await notes(w.manager.id, 'retention.reminder')).toHaveLength(2);
  });

  it('counts the extra year from today when the decision comes after the period has ended', async () => {
    const { orderId, deadline } = await lostOrderWithBill();
    at(daysAfter(deadline, 100));
    await job();
    const kept = await keepDocumentsAnotherYear(as(w.manager, w.clock), { orderId });
    expect(kept.keptUntil).toEqual(addYears(w.clock.current, 1));
  });

  it('deletes softly, with an audit entry for every file, and is not stopped by the rules for orders in progress', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const quote = await createQuote(as(w.sam, w.clock), { orderId, title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, notes: '', file: await staged(pdf('quote file'), 'quote.pdf') });
    await markQuoteSent(as(w.sam, w.clock), { quoteId: quote.id });
    const photo = await upload(orderId, 'meter_box', 'meter.png', await png(4));
    const quoteDoc = (await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).documentId!;
    // While the order is alive the file of a quote that went to the customer cannot be deleted.
    await expect(deleteDocument(as(w.sam, w.clock), { documentId: quoteDoc })).rejects.toMatchObject({ code: 'conflict' });

    const lostAt = await lose(orderId);
    at(daysBefore(addYears(lostAt, 2), 3));
    await job();
    // The ordinary delete is closed on a lost order; the retention decision is not.
    await expect(deleteDocument(as(w.sam, w.clock), { documentId: photo.id })).rejects.toMatchObject({ code: 'conflict' });
    expect(await deleteExpiringDocuments(as(w.manager, w.clock), { orderId })).toEqual({ deleted: 2 });

    const rows = await db.document.findMany({ where: { orderId }, orderBy: { fileName: 'asc' } });
    expect(rows.map((d) => [d.fileName, d.deletedAt, d.deletedById, d.purgedAt])).toEqual([
      ['meter.png', w.clock.current, w.manager.id, null],
      ['quote.pdf', w.clock.current, w.manager.id, null],
    ]);
    // Soft: the bytes are still there, the documents are simply no longer shown or served.
    expect(rows.every((d) => onDisk(d.storageKey))).toBe(true);
    expect((await getOrderDocuments(as(w.sam, w.clock), orderId)).documents).toEqual([]);
    await expect(openDocument(as(w.sam, w.clock), { documentId: photo.id, purpose: 'download' })).rejects.toMatchObject({ code: 'not_found' });

    const log = await db.auditLog.findMany({ where: { orderId, action: 'document.delete' }, orderBy: { summary: 'asc' } });
    expect(log.map((l) => [l.entityId, l.actorLabel])).toEqual(expect.arrayContaining([[photo.id, 'Morgan Manager'], [quoteDoc, 'Morgan Manager']]));
    expect(log).toHaveLength(2);
    expect(log[0]!.summary).toMatch(/deleted .+ at the end of its retention period$/);
    expect(log[0]!.meta).toMatchObject({ retention: 'decision' });
    expect(log[0]!.before).toMatchObject({ fileName: expect.any(String), sha256: expect.any(String) });
    const entry = await db.activity.findFirstOrThrow({ where: { orderId, type: 'DOCUMENT' }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] });
    expect(entry.summary).toBe('Deleted 2 documents at the end of their retention period');
    // Decided: the order is off the list and the job has nothing more to say about it.
    expect((await listRetentionOrders(as(w.manager, w.clock))).rows).toEqual([]);
    await expect(deleteExpiringDocuments(as(w.manager, w.clock), { orderId })).rejects.toMatchObject({ code: 'conflict' });
    w.clock.advanceDays(20);
    expect(await job()).toEqual(NOTHING);
  });
});

describe('when nobody decides', () => {
  it('deletes nothing by default: the order stays listed and the managers are reminded again, weekly at most', async () => {
    const { orderId, billId, deadline } = await lostOrderWithBill();
    at(daysBefore(deadline, 30));
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });
    at(daysBefore(deadline, 1));
    expect(await job()).toEqual(NOTHING);

    // The period ends. Nothing is deleted; the managers hear about it again.
    at(daysAfter(deadline, 0.1));
    expect(await job()).toEqual({ ...NOTHING, repeatReminders: 1 });
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'PAST', autoDeleteAt: null });
    const [again] = await notes(w.manager.id, 'retention.overdue');
    expect(again!.title).toContain('1 document is past its retention period and still waiting for a decision');
    expect(again!.href).toBe(`/orders/${orderId}?tab=documents#retention`);
    expect(await notes(w.sam.id, 'retention.overdue')).toEqual([]);

    // Not more than once a week.
    w.clock.advanceDays(6.8);
    expect(await job()).toEqual(NOTHING);
    w.clock.advanceDays(0.3);
    expect(await job()).toEqual({ ...NOTHING, repeatReminders: 1 });
    w.clock.advanceDays(7.1);
    expect(await job()).toEqual({ ...NOTHING, repeatReminders: 1 });
    expect(await notes(w.manager.id, 'retention.overdue')).toHaveLength(3);
    expect(await notes(w.manager.id, 'retention.reminder')).toHaveLength(1);

    // A year and a half later the file is still there and the order is still on the managers' list.
    w.clock.advanceDays(500);
    await job();
    expect((await db.document.findUniqueOrThrow({ where: { id: billId } })).deletedAt).toBeNull();
    const list = await listRetentionOrders(as(w.manager, w.clock));
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ id: orderId, customerName: 'Jane Smith', ownerName: 'Sam Sales', ended: 'LOST', deadline, past: true, documents: 1, autoDeleteAt: null });
    await expect(listRetentionOrders(as(w.sam, w.clock))).rejects.toMatchObject({ code: 'forbidden' });

    // A decision ends the reminders.
    await keepDocumentsAnotherYear(as(w.manager, w.clock), { orderId });
    w.clock.advanceDays(8);
    expect(await job()).toEqual(NOTHING);
  });

  it('deletes at the end of the period once an admin has switched automatic deletion on', async () => {
    await setRetention({ autoDelete: true });
    const { orderId, billId, deadline } = await lostOrderWithBill();
    at(daysBefore(deadline, 30));
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });
    const [warning] = await notes(w.sam.id, 'retention.reminder');
    expect(warning!.body).toContain(`If nobody decides, it is deleted automatically on ${day(deadline)}.`);
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'DUE', autoDeleteAt: deadline });

    // Not a day early.
    at(daysBefore(deadline, 0.1));
    expect(await job()).toEqual(NOTHING);
    at(daysAfter(deadline, 0.1));
    expect(await job()).toEqual({ ...NOTHING, deleted: 1 });

    const bill = await db.document.findUniqueOrThrow({ where: { id: billId } });
    expect(bill).toMatchObject({ deletedAt: w.clock.current, deletedById: null, purgedAt: null });
    expect(onDisk(bill.storageKey)).toBe(true);
    const log = await db.auditLog.findFirstOrThrow({ where: { entityId: billId, action: 'document.delete' } });
    expect(log).toMatchObject({ actorId: null, actorLabel: 'System' });
    expect(log.summary).toContain('at the end of its retention period (automatically, nobody had decided)');
    expect(log.meta).toMatchObject({ retention: 'automatic' });
    for (const person of [w.sam, w.manager]) {
      const [told] = await notes(person.id, 'retention.auto_deleted');
      expect(told!.title).toContain('1 document was deleted automatically at the end of its retention period');
    }
    // Done: nothing more happens to this order until the purge.
    expect(await job()).toEqual(NOTHING);
    expect(await retentionAwaitingCount(db, w.clock.current)).toBe(0);
  });

  it('never deletes automatically before the reminder has had its full lead time', async () => {
    await setRetention({ autoDelete: true });
    const { billId, deadline } = await lostOrderWithBill();
    // The worker was down when the reminder should have gone out; it comes back after the period has ended.
    at(daysAfter(deadline, 5));
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });
    const [late] = await notes(w.sam.id, 'retention.reminder');
    expect(late!.title).toContain(`the retention period of 1 document ended on ${day(deadline)}`);
    expect(late!.body).toContain(`deleted automatically on ${day(daysAfter(w.clock.current, 30))}`);

    w.clock.advanceDays(29.5);
    expect(await job()).toEqual(NOTHING);
    expect((await db.document.findUniqueOrThrow({ where: { id: billId } })).deletedAt).toBeNull();
    w.clock.advanceDays(1);
    expect(await job()).toEqual({ ...NOTHING, deleted: 1 });
  });

  it('leaves alone what somebody decided to keep, and catches up when the switch is turned on later', async () => {
    const kept = await lostOrderWithBill();
    const ignored = await lostOrderWithBill({ phone: '0400 555 666', email: 'second@example.com', address: '2 Other Rd' });
    at(daysBefore(kept.deadline, 30));
    expect(await job()).toMatchObject({ reminders: 2 });
    await keepDocumentsAnotherYear(as(w.sam, w.clock), { orderId: kept.orderId });

    // Months after the end, with weekly reminders ignored, the admin has had enough.
    at(daysAfter(kept.deadline, 90));
    await job();
    await setRetention({ autoDelete: true });
    expect(await job()).toEqual({ ...NOTHING, deleted: 1 });
    expect((await db.document.findUniqueOrThrow({ where: { id: ignored.billId } })).deletedAt).not.toBeNull();
    expect((await db.document.findUniqueOrThrow({ where: { id: kept.billId } })).deletedAt).toBeNull();
  });
});

describe('removing deleted files from storage', () => {
  it('removes the file and its thumbnail 30 days after any deletion, keeps the row, and answers 410 from then on', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const photo = await upload(orderId, 'meter_box', 'meter.png', await png(7));
    const note = await upload(orderId, 'other', 'notes.txt', Buffer.from('hello'));
    await deleteDocument(as(w.sam, w.clock), { documentId: photo.id });
    const deletedAt = w.clock.current;
    const before = await db.document.findUniqueOrThrow({ where: { id: photo.id } });
    expect(before.thumbKey).not.toBeNull();

    at(daysAfter(deletedAt, 29.9));
    expect(await job()).toEqual(NOTHING);
    expect(onDisk(before.storageKey) && onDisk(before.thumbKey)).toBe(true);

    at(daysAfter(deletedAt, 30));
    expect(await job()).toEqual({ ...NOTHING, purged: 1, filesRemoved: 1 });
    const after = await db.document.findUniqueOrThrow({ where: { id: photo.id } });
    expect(after).toMatchObject({ purgedAt: w.clock.current, deletedAt, fileName: 'meter.png', sha256: before.sha256 });
    expect(onDisk(before.storageKey)).toBe(false);
    expect(onDisk(before.thumbKey)).toBe(false);
    // The file next to it is untouched.
    expect(onDisk((await db.document.findUniqueOrThrow({ where: { id: note.id } })).storageKey)).toBe(true);

    const log = await db.auditLog.findFirstOrThrow({ where: { entityId: photo.id, action: 'document.purge' } });
    expect(log.summary).toContain('removed Meter box / switchboard photos “meter.png” from storage, 30 days after it was deleted');
    expect(log.meta).toMatchObject({ fileRemoved: true, stillUsedBy: 0 });

    // A request for it fails cleanly: gone for those who could have opened it, unknown to everyone else.
    for (const purpose of ['download', 'view', 'thumbnail', 'head'] as const) {
      await expect(openDocument(as(w.sam, w.clock), { documentId: photo.id, purpose })).rejects.toMatchObject({ code: 'gone', status: 410, message: expect.stringContaining('removed from storage') });
    }
    await expect(openDocument(as(w.alex, w.clock), { documentId: photo.id, purpose: 'download' })).rejects.toMatchObject({ code: 'not_found' });
    // And it is purged once.
    w.clock.advanceDays(40);
    expect(await job()).toEqual(NOTHING);
  });

  it('keeps the bytes for as long as a later order at the same property still uses the photo', async () => {
    const first = await orderAt(w, 'ASSIGNED');
    const original = await upload(first.orderId, 'meter_box', 'meter.png', await png(21));
    const lostAt = await lose(first.orderId);
    // The customer comes back: a second order on the same property takes the photo over.
    const second = await orderAt(w, 'NEW');
    const sam = as(w.sam, w.clock);
    const offered = await listReusableDocuments(sam, second.orderId);
    expect(await reuseDocuments(sam, { orderId: second.orderId, documentIds: offered.map((d) => d.id) })).toEqual({ reused: 1 });
    const copy = await db.document.findFirstOrThrow({ where: { orderId: second.orderId } });
    const file = await db.document.findUniqueOrThrow({ where: { id: original.id } });
    expect(copy).toMatchObject({ copiedFromId: original.id, storageKey: file.storageKey, thumbKey: file.thumbKey });

    // Two years on, the first order's photo is deleted at the end of its retention period…
    at(daysBefore(addYears(lostAt, 2), 10));
    await job();
    expect(await deleteExpiringDocuments(as(w.manager, w.clock), { orderId: first.orderId })).toEqual({ deleted: 1 });
    // …and a month later its record is closed. The bytes stay: the second order still shows them.
    w.clock.advanceDays(31);
    expect(await job()).toEqual({ ...NOTHING, purged: 1, filesRemoved: 0 });
    expect((await db.document.findUniqueOrThrow({ where: { id: original.id } })).purgedAt).toEqual(w.clock.current);
    expect(onDisk(file.storageKey) && onDisk(file.thumbKey)).toBe(true);
    expect(await openDocument(sam, { documentId: copy.id, purpose: 'view' })).toMatchObject({ storageKey: file.storageKey });
    await expect(openDocument(sam, { documentId: original.id, purpose: 'view' })).rejects.toMatchObject({ code: 'gone' });
    const log = await db.auditLog.findFirstOrThrow({ where: { entityId: original.id, action: 'document.purge' } });
    expect(log.summary).toContain('the file stays in storage because another order still uses it');
    expect(log.meta).toMatchObject({ fileRemoved: false, stillUsedBy: 1 });

    // Only when the last document using the file is deleted and purged do the bytes go.
    await deleteDocument(sam, { documentId: copy.id });
    w.clock.advanceDays(29);
    expect(await job()).toEqual(NOTHING);
    expect(onDisk(file.storageKey)).toBe(true);
    w.clock.advanceDays(1.1);
    expect(await job()).toEqual({ ...NOTHING, purged: 1, filesRemoved: 1 });
    expect(onDisk(file.storageKey) || onDisk(file.thumbKey)).toBe(false);
  });

  it('keeps the bytes when the reused copy goes first and the original is still in use', async () => {
    const first = await orderAt(w, 'ASSIGNED');
    const original = await upload(first.orderId, 'meter_box', 'meter.png', await png(33));
    await lose(first.orderId);
    const second = await orderAt(w, 'NEW');
    const sam = as(w.sam, w.clock);
    await reuseDocuments(sam, { orderId: second.orderId, documentIds: [original.id] });
    // The second enquiry turns out to be for another house: the reused photo is set aside.
    await moveOrderToNewProperty(sam, { orderId: second.orderId, addressLine1: '9 Harbour Rd', addressLine2: '', suburb: 'Manly', state: 'NSW', postcode: '2095', propertyType: 'House' });
    const copy = await db.document.findFirstOrThrow({ where: { orderId: second.orderId } });
    expect(copy.deletedAt).not.toBeNull();

    w.clock.advanceDays(31);
    expect(await job()).toEqual({ ...NOTHING, purged: 1, filesRemoved: 0 });
    const file = await db.document.findUniqueOrThrow({ where: { id: original.id } });
    expect(file.purgedAt).toBeNull();
    expect(onDisk(file.storageKey) && onDisk(file.thumbKey)).toBe(true);
    expect(await openDocument(as(w.manager, w.clock), { documentId: original.id, purpose: 'view' })).toMatchObject({ id: original.id });
  });

  it('removes the copy in the mail store of a file that came in by e-mail, and leaves the message itself', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const bill = await upload(orderId, 'electricity_bill', 'bill.pdf', pdf('bill from mail'));
    const o = await order(orderId);
    // The way reading a mailbox stores an attachment that was then filed as this document.
    const copyKey = `mail/${o.customerId}/eml_1/ema_1.pdf`;
    await getStorage().writeBuffer(copyKey, pdf('bill from mail'));
    await db.emailMessage.create({ data: { id: 'eml_1', customerId: o.customerId, orderId, direction: 'IN', fromAddress: 'jane@example.com', toAddresses: ['sam@bluven.example'], subject: 'My bill', bodyText: 'Attached.', sentAt: w.clock.now() } });
    await db.emailAttachment.create({ data: { id: 'ema_1', messageId: 'eml_1', fileName: 'bill.pdf', mimeType: 'application/pdf', sizeBytes: 60, storageKey: copyKey, documentId: bill.id } });
    await db.emailAttachment.create({ data: { id: 'ema_2', messageId: 'eml_1', fileName: 'other.pdf', mimeType: 'application/pdf', sizeBytes: 60, storageKey: `mail/${o.customerId}/eml_1/ema_2.pdf` } });

    await deleteDocument(as(w.sam, w.clock), { documentId: bill.id });
    w.clock.advanceDays(29);
    await job();
    expect(onDisk(copyKey)).toBe(true);
    w.clock.advanceDays(2);
    expect(await job()).toEqual({ ...NOTHING, purged: 1, filesRemoved: 1 });
    expect(onDisk(copyKey)).toBe(false);
    const copy = await db.emailAttachment.findUniqueOrThrow({ where: { id: 'ema_1' } });
    expect(copy).toMatchObject({ storageKey: null, skippedReason: 'Removed together with the document it was filed as.' });
    // What was never filed is not a document of the order, and stays with its message.
    expect((await db.emailAttachment.findUniqueOrThrow({ where: { id: 'ema_2' } })).storageKey).not.toBeNull();
    expect(await db.emailMessage.count({ where: { id: 'eml_1' } })).toBe(1);
  });

  it('does not purge a deleted file of a type that is never deleted automatically', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const paper = await upload(orderId, 'other', 'compliance.pdf', pdf('compliance'));
    await db.documentType.update({ where: { key: 'other' }, data: { neverAutoDelete: true } });
    await deleteDocument(as(w.sam, w.clock), { documentId: paper.id });
    w.clock.advanceDays(400);
    expect(await job()).toEqual(NOTHING);
    const row = await db.document.findUniqueOrThrow({ where: { id: paper.id } });
    expect(row.purgedAt).toBeNull();
    expect(onDisk(row.storageKey)).toBe(true);
  });
});

describe('retention settings', () => {
  it('lets an admin change the period, the lead time and the automatic-delete switch, and nobody else', async () => {
    expect((await getSettings(db)).retention).toEqual({ years: 2, reminderDays: 30, autoDelete: false });
    const admin = await makeUser(['ADMIN']);
    const base = await getSettings(db);
    await expect(updateSettings(as(w.manager), { ...base, retention: { years: 3, reminderDays: 60, autoDelete: true } })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateSettings(as(admin), { ...base, retention: { years: 0, reminderDays: 0, autoDelete: false } })).rejects.toMatchObject({
      fieldErrors: { retentionYears: expect.any(String), retentionReminderDays: expect.any(String) },
    });
    await expect(updateSettings(as(admin), { ...base, retention: { years: 1, reminderDays: 365, autoDelete: false } })).rejects.toMatchObject({
      fieldErrors: { retentionReminderDays: 'Must be shorter than the retention period.' },
    });

    const saved = await updateSettings(as(admin), { ...base, retention: { years: 3, reminderDays: 60, autoDelete: true } });
    expect(saved.retention).toEqual({ years: 3, reminderDays: 60, autoDelete: true });
    expect((await getSettings(db)).retention).toEqual({ years: 3, reminderDays: 60, autoDelete: true });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: 'settings.update' }, orderBy: { at: 'desc' } });
    expect(log.before).toMatchObject({ retention: { years: 2, reminderDays: 30, autoDelete: false } });
    expect(log.after).toMatchObject({ retention: { years: 3, reminderDays: 60, autoDelete: true } });

    // A form that only knows the older settings leaves retention as it is.
    await updateSettings(as(admin), { idle: { remindOwnerDays: 4, remindManagerDays: 8, returnToPoolDays: 12 }, defaultDepositPercent: 15 });
    expect(await getSettings(db)).toEqual({ idle: { remindOwnerDays: 4, remindManagerDays: 8, returnToPoolDays: 12 }, defaultDepositPercent: 15, retention: { years: 3, reminderDays: 60, autoDelete: true } });
  });

  it('follows the period and the lead time an admin sets', async () => {
    const { orderId, deadline } = await lostOrderWithBill();
    const lostAt = addYears(deadline, -2);
    await setRetention({ years: 3, reminderDays: 60 });
    expect(await getOrderRetention(as(w.sam, w.clock), orderId)).toMatchObject({ status: 'KEPT', deadline: addYears(lostAt, 3), reminderDays: 60 });
    at(daysBefore(addYears(lostAt, 3), 61));
    expect(await job()).toEqual(NOTHING);
    at(daysBefore(addYears(lostAt, 3), 60));
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });
    // Shortening the period afterwards moves the end date, and a new end date gets its own reminder.
    await setRetention({ years: 2, reminderDays: 30 });
    expect(await job()).toEqual({ ...NOTHING, reminders: 1 });
    const [, second] = await notes(w.sam.id, 'retention.reminder');
    expect(second!.title).toContain(`the retention period of 1 document ended on ${day(deadline)}`);
  });
});

describe('what the job owes an order', () => {
  const s: RetentionSettings = { years: 2, reminderDays: 30, autoDelete: false };
  const now = new Date('2028-11-10T00:00:00Z');
  const ends = (days: number) => daysAfter(now, days);

  it('is nothing until the reminder window opens, then one reminder per end date', () => {
    expect(nextRetentionStep({ deadline: null, remindedFor: null, remindedAt: null, nudgedAt: null }, s, now)).toBeNull();
    expect(nextRetentionStep({ deadline: ends(31), remindedFor: null, remindedAt: null, nudgedAt: null }, s, now)).toBeNull();
    expect(nextRetentionStep({ deadline: ends(30), remindedFor: null, remindedAt: null, nudgedAt: null }, s, now)).toBe('REMIND');
    expect(nextRetentionStep({ deadline: ends(10), remindedFor: ends(10), remindedAt: ends(-20), nudgedAt: null }, s, now)).toBeNull();
    // Reminded about an earlier end date: this one is new.
    expect(nextRetentionStep({ deadline: ends(10), remindedFor: ends(-355), remindedAt: ends(-385), nudgedAt: ends(-300) }, s, now)).toBe('REMIND');
  });

  it('is a weekly reminder to managers after the end, or deletion when that is switched on', () => {
    const reminded = { deadline: ends(-1), remindedFor: ends(-1), remindedAt: ends(-31) };
    expect(nextRetentionStep({ ...reminded, nudgedAt: null }, s, now)).toBe('NUDGE');
    expect(nextRetentionStep({ ...reminded, nudgedAt: ends(-6.9) }, s, now)).toBeNull();
    expect(nextRetentionStep({ ...reminded, nudgedAt: ends(-7) }, s, now)).toBe('NUDGE');
    expect(nextRetentionStep({ ...reminded, nudgedAt: ends(-7) }, { ...s, autoDelete: true }, now)).toBe('DELETE');
    // Reminded only five days ago: not yet.
    expect(nextRetentionStep({ deadline: ends(-10), remindedFor: ends(-10), remindedAt: ends(-5), nudgedAt: null }, { ...s, autoDelete: true }, now)).toBeNull();
  });
});
