// Lists and figures that have to agree with what they stand for: the operations inbox, the
// dashboard, and a few rules around returned orders and moved properties.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_DOCUMENT,
  createLeadManually,
  countReportOrders,
  getDashboard,
  holdOrder,
  idleTier,
  ingestLeads,
  iterateReportOrders,
  listHandoffs,
  listPipelineOrders,
  moveOrderToNewProperty,
  parseDateOnly,
  pushOrder,
  returnHandoff,
  reuseDocuments,
  systemCtx,
  uploadDocument,
  listReusableDocuments,
  markLost,
} from '../src';
import { as, docType, lead, png, resetDb, source, stream, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('orders that came back from operations', () => {
  it('appear once in the operations list however often they were returned', async () => {
    const { orderId } = await orderAt(w, 'READY');
    const sam = as(w.sam, w.clock);
    const ops = as(w.ops, w.clock);
    await pushOrder(sam, { orderId });
    await returnHandoff(ops, { orderId, reason: 'Meter box photo is blurry.' });
    await pushOrder(sam, { orderId });
    w.clock.advanceMinutes(5);
    await returnHandoff(ops, { orderId, reason: 'Still blurry.' });

    const returned = await listHandoffs(ops, 'RETURNED');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ orderId, returnReason: 'Still blurry.' });
  });

  it('cannot be parked on hold', async () => {
    const { orderId } = await orderAt(w, 'READY');
    await pushOrder(as(w.sam, w.clock), { orderId });
    await returnHandoff(as(w.ops, w.clock), { orderId, reason: 'Bill is missing.' });
    await expect(holdOrder(as(w.sam, w.clock), { orderId, until: parseDateOnly('2026-12-01'), note: 'later' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('came back from operations'),
    });
  });
});

describe('moving an order to another property', () => {
  it('takes its own site photos along and leaves behind the ones reused from the old address', async () => {
    // A finished order at the first address, with a meter box photo.
    const first = await orderAt(w, 'ASSIGNED');
    const sam = as(w.sam, w.clock);
    await uploadDocument(sam, { orderId: first.orderId, typeId: (await docType('meter_box')).id, fileName: 'old-meter.png', body: stream(await png(3)) });
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await markLost(sam, { orderId: first.orderId, reasonId: reason.id });

    // A new enquiry is attached to the same address at first; the photo is reused, another one added.
    const second = await createLeadManually(as(w.manager, w.clock), lead({ externalId: undefined }), { ownerId: w.sam.id });
    const offered = await listReusableDocuments(sam, second.orderId);
    await reuseDocuments(sam, { orderId: second.orderId, documentIds: offered.map((d) => d.id) });
    await uploadDocument(sam, { orderId: second.orderId, typeId: (await docType('install_location')).id, fileName: 'new-roof.png', body: stream(await png(9)) });

    // It turns out to be for the customer's other house.
    await moveOrderToNewProperty(sam, { orderId: second.orderId, addressLine1: '9 Harbour Rd', addressLine2: '', suburb: 'Manly', state: 'NSW', postcode: '2095', propertyType: 'House' });
    const order = await db.order.findUniqueOrThrow({ where: { id: second.orderId } });
    const current = await db.document.findMany({ where: { orderId: second.orderId, ...CURRENT_DOCUMENT }, select: { fileName: true, propertyId: true } });
    expect(current).toEqual([{ fileName: 'new-roof.png', propertyId: order.propertyId }]);
    expect(await db.activity.count({ where: { orderId: second.orderId, body: { contains: '1 site photo reused' } } })).toBe(1);
    // The original photo is untouched on the order it belongs to.
    expect(await db.document.count({ where: { orderId: first.orderId, ...CURRENT_DOCUMENT } })).toBe(1);
  });
});

describe('possible duplicates outside the pool', () => {
  it('are brought to the managers, since nobody would see the flag otherwise', async () => {
    const sourceId = (await source('bluven-website')).id;
    const intake = systemCtx(db, 'Bluven website', w.clock.now);
    // Two different customers, one known by phone and one by email, both looked after by Sam.
    const a = await createLeadManually(as(w.sam, w.clock), lead({ externalId: undefined, phone: '0400 111 000', email: 'a@example.com', address: '1 First St' }));
    await createLeadManually(as(w.sam, w.clock), lead({ externalId: undefined, firstName: 'Other', phone: '0400 222 000', email: 'b@example.com', address: '2 Second St' }));
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await markLost(as(w.sam, w.clock), { orderId: a.orderId, reasonId: reason.id });
    await db.notification.deleteMany();

    // A new enquiry carries the first one's phone and the second one's email. It goes straight to Sam.
    const res = await ingestLeads(intake, [lead({ externalId: 'mix', phone: '0400 111 000', email: 'b@example.com', address: '3 Third St' })], { sourceId, requireExternalId: true });
    const created = await db.order.findUniqueOrThrow({ where: { id: res.results[0]!.id! } });
    expect(created.ownerId).toBe(w.sam.id);
    expect(created.possibleDuplicateOfId).not.toBeNull();
    expect((await db.notification.findMany({ where: { type: 'order.possible_duplicate' } })).map((n) => n.userId)).toEqual([w.manager.id]);
  });
});

describe('dashboard figures', () => {
  it('shows a funnel that only narrows, and counts what waits for finance as orders', async () => {
    // Quoted and signed without anyone logging a call first.
    const { orderId } = await orderAt(w, 'DEPOSIT_PENDING');
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).firstContactedAt).toBeNull();
    // A second order that is only assigned.
    await orderAt(w, 'ASSIGNED', { phone: '0400 555 666', email: 'second@example.com', address: '2 Other Rd' });

    const d = await getDashboard(as(w.manager, w.clock), { from: '2026-11-01', to: '2026-11-30' });
    const row = d.bySource.find((s) => s.name === 'Bluven website')!;
    expect(row).toMatchObject({ leads: 2, contacted: 1, quoted: 1, signed: 1 });
    expect(row.contacted).toBeGreaterThanOrEqual(row.quoted);
    expect(row.quoted).toBeGreaterThanOrEqual(row.signed);
    expect(d.totals.pendingDeposits).toBe(1);
  });

  it('counts a day by the calendar across the end of daylight saving', async () => {
    const sourceId = (await source('bluven-website')).id;
    const at = (iso: string) => systemCtx(db, 'Bluven website', () => new Date(iso));
    // Sunday 5 April 2026 has 25 hours in Sydney. 23:30 that evening is 13:30 UTC.
    await ingestLeads(at('2026-04-05T13:30:00Z'), [lead({ externalId: 'late', phone: '0400 000 001', email: 'late@example.com' })], { sourceId, requireExternalId: true });
    // 00:30 on Monday is 14:30 UTC.
    await ingestLeads(at('2026-04-05T14:30:00Z'), [lead({ externalId: 'next', phone: '0400 000 002', email: 'next@example.com', address: '8 Next St' })], { sourceId, requireExternalId: true });
    const sunday = await getDashboard(as(w.manager, w.clock), { from: '2026-04-05', to: '2026-04-05' });
    expect(sunday.totals.leads).toBe(1);
    const monday = await getDashboard(as(w.manager, w.clock), { from: '2026-04-06', to: '2026-04-06' });
    expect(monday.totals.leads).toBe(1);
  });
});

describe('idle orders', () => {
  it('are counted the same way in the figures, per salesperson and in the list behind each figure', async () => {
    // Four of Sam's orders, last touched 3, 6, 11 and 16 days ago, and one of Alex's, 12 days ago.
    const ids: Record<string, string> = {};
    for (const [name, days] of [['fresh', 3], ['five', 6], ['ten', 11], ['fifteen', 16]] as const) {
      const { orderId } = await orderAt(w, 'ASSIGNED', { firstName: name, phone: `0400 10${days} 00${days}`.slice(0, 12), email: `${name}@example.com`, address: `${days} Idle St` });
      await db.order.update({ where: { id: orderId }, data: { lastStaffActivityAt: new Date(w.clock.now().getTime() - days * 86_400_000) } });
      ids[name] = orderId;
    }
    const other = await orderAt(w, 'ASSIGNED', { firstName: 'alexs', phone: '0400 777 888', email: 'alexs@example.com', address: '1 Alex St' });
    await db.order.update({ where: { id: other.orderId }, data: { ownerId: w.alex.id, lastStaffActivityAt: new Date(w.clock.now().getTime() - 12 * 86_400_000) } });
    // The reminder job has not run: no reminder has gone out, and the figures do not wait for it.
    expect(await db.order.count({ where: { idleLevel: { gt: 0 } } })).toBe(0);

    const manager = as(w.manager, w.clock);
    const d = await getDashboard(manager, { from: '2026-11-01', to: '2026-11-30' });
    expect(d.idleDays).toEqual([5, 10, 15]);
    expect(d.totals.idle).toEqual([4, 3, 1]);
    expect(d.bySalesperson.find((p) => p.userId === w.sam.id)).toMatchObject({ idle: 3, idleLong: 2 });
    expect(d.bySalesperson.find((p) => p.userId === w.alex.id)).toMatchObject({ idle: 1, idleLong: 1 });

    // Each figure opens exactly the orders it counts.
    const listed = async (idle: 1 | 2 | 3) => (await listPipelineOrders(manager, { idle })).rows.map((r) => r.id).sort();
    expect(await listed(1)).toEqual([ids.five, ids.ten, ids.fifteen, other.orderId].sort());
    expect(await listed(2)).toEqual([ids.ten, ids.fifteen, other.orderId].sort());
    expect(await listed(3)).toEqual([ids.fifteen]);
    // A salesperson sees their own.
    expect((await getDashboard(as(w.sam, w.clock), { from: '2026-11-01', to: '2026-11-30' })).totals.idle).toEqual([3, 2, 1]);
    expect((await listPipelineOrders(as(w.sam, w.clock), { idle: 2 })).total).toBe(2);

    // An order on hold, or one waiting for finance, is not idle however long it sits.
    await holdOrder(as(w.sam, w.clock), { orderId: ids.ten!, until: parseDateOnly('2026-12-20'), note: 'travelling' });
    expect((await getDashboard(manager, { from: '2026-11-01', to: '2026-11-30' })).totals.idle).toEqual([3, 2, 1]);
    const row = await db.order.findUniqueOrThrow({ where: { id: ids.ten } });
    expect(idleTier(row, w.clock.now(), { remindOwnerDays: 5, remindManagerDays: 10, returnToPoolDays: 15 })).toBe(0);
  });
});

describe('the report over time', () => {
  it('shows twelve calendar months, and how long enquiries take to become contracts', async () => {
    const sourceId = (await source('bluven-website')).id;
    const at = (iso: string) => systemCtx(db, 'Bluven website', () => new Date(iso));
    // The clock stands at 10 November 2026. One enquiry in September, two in November.
    await ingestLeads(at('2026-09-15T02:00:00Z'), [lead({ externalId: 'sep', phone: '0400 000 011', email: 'sep@example.com', address: '1 Sep St' })], { sourceId, requireExternalId: true });
    // 31 October 23:30 in Sydney is still October there, although it is 12:30 UTC.
    await ingestLeads(at('2026-10-31T12:30:00Z'), [lead({ externalId: 'oct', phone: '0400 000 012', email: 'oct@example.com', address: '1 Oct St' })], { sourceId, requireExternalId: true });
    // 1 November 00:30 in Sydney is 13:30 UTC on 31 October.
    await ingestLeads(at('2026-10-31T13:30:00Z'), [lead({ externalId: 'nov', phone: '0400 000 013', email: 'nov@example.com', address: '1 Nov St' })], { sourceId, requireExternalId: true });
    const { orderId } = await orderAt(w, 'SIGNED');
    // Signed on 9 November for an enquiry of 10 November 12:00 Sydney time: never a negative number of days.
    const sep = await db.order.findFirstOrThrow({ where: { externalLeadId: 'sep' } });
    await db.order.update({ where: { id: sep.id }, data: { signedAt: parseDateOnly('2026-10-05'), ownerId: w.sam.id } });

    const d = await getDashboard(as(w.manager, w.clock), { from: '2026-09-01', to: '2026-11-30' });
    expect(d.monthly).toHaveLength(12);
    expect(d.monthly[0]!.month).toBe('2025-12');
    expect(d.monthly.slice(-3)).toEqual([
      { month: '2026-09', leads: 1, signed: 0, handedOver: 0, lost: 0 },
      { month: '2026-10', leads: 1, signed: 1, handedOver: 0, lost: 0 },
      { month: '2026-11', leads: 2, signed: 1, handedOver: 0, lost: 0 },
    ]);
    // 15 September to 5 October is 20 days; the other contract counts as signed the day of the enquiry.
    const row = d.bySource.find((s) => s.name === 'Bluven website')!;
    expect(row).toMatchObject({ leads: 4, signed: 2, avgDaysToSign: 10 });
    expect(d.totals.avgDaysToSign).toBe(10);
    // Only the contracts signed in the chosen period count towards the average.
    expect((await getDashboard(as(w.manager, w.clock), { from: '2026-10-01', to: '2026-10-31' })).totals.avgDaysToSign).toBe(20);
    expect((await getDashboard(as(w.manager, w.clock), { from: '2026-08-01', to: '2026-08-31' })).totals.avgDaysToSign).toBeNull();

    await markLost(as(w.sam, w.clock), { orderId, reasonId: (await db.lostReason.findFirstOrThrow({ where: { key: 'price' } })).id });
    expect((await getDashboard(as(w.manager, w.clock), { from: '2026-09-01', to: '2026-11-30' })).monthly.at(-1)).toMatchObject({ month: '2026-11', lost: 1 });
  });

  it('exports the orders of a period, a page at a time: all of them for a manager, their own for a salesperson', async () => {
    const mine = await orderAt(w, 'DEPOSIT_CONFIRMED');
    const second = await orderAt(w, 'ASSIGNED', { firstName: 'Bo', phone: '0400 555 666', email: 'bo@example.com', address: '2 Other Rd' });
    await db.order.update({ where: { id: second.orderId }, data: { ownerId: w.alex.id } });
    const range = { from: '2026-11-01', to: '2026-11-30' };

    const collect = async (ctx: Parameters<typeof iterateReportOrders>[0], pageSize?: number) => {
      const pages: number[] = [];
      const rows = [];
      for await (const page of iterateReportOrders(ctx, range, pageSize)) {
        pages.push(page.length);
        rows.push(...page);
      }
      return { pages, rows };
    };
    const all = await collect(as(w.manager, w.clock), 1);
    expect(all.pages).toEqual([1, 1]);
    expect(await countReportOrders(as(w.manager, w.clock), range)).toBe(2);
    const row = all.rows.find((r) => r.id === mine.orderId)!;
    expect(row).toMatchObject({ customerName: 'Jane Smith', address: '12 Sample St, Parramatta NSW 2150', stage: 'DEPOSIT_CONFIRMED', source: { name: 'Bluven website' }, owner: { name: 'Sam Sales' } });
    expect(row.quotes[0]).toMatchObject({ dcWatts: 6600, totalCents: 900_000 });
    expect(row.deposits[0]).toMatchObject({ receivedAmountCents: 90_000 });
    expect(row.signedAt).not.toBeNull();

    expect((await collect(as(w.sam, w.clock))).rows.map((r) => r.id)).toEqual([mine.orderId]);
    expect(await countReportOrders(as(w.sam, w.clock), { from: '2026-10-01', to: '2026-10-31' })).toBe(0);
    // Finance and operations have no report of the pipeline.
    await expect(countReportOrders(as(w.fin, w.clock), range)).rejects.toThrow('not allowed');
    await expect(collect(as(w.ops, w.clock))).rejects.toThrow('not allowed');
  });
});
