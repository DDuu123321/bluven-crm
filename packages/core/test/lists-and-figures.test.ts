// Lists and figures that have to agree with what they stand for: the operations inbox, the
// dashboard, and a few rules around returned orders and moved properties.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_DOCUMENT,
  confirmFinalPayment,
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
  openJob,
  parseDateOnly,
  pushOrder,
  returnHandoff,
  reuseDocuments,
  systemCtx,
  uploadDocument,
  listReusableDocuments,
  markLost,
} from '../src';
import { as, docType, lead, leadOrigin, png, resetDb, source, stream, testDb } from './helpers';
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
    const first = await orderAt(w, 'OPENED');
    const sam = as(w.sam, w.clock);
    await uploadDocument(sam, { orderId: first.orderId, typeId: (await docType('meter_box')).id, fileName: 'old-meter.png', body: stream(await png(3)) });
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await markLost(sam, { orderId: first.orderId, reasonId: reason.id });

    // A new enquiry is attached to the same address at first; the photo is reused, another one added.
    const second = await createLeadManually(as(w.manager, w.clock), lead({ externalId: undefined }), { ownerId: w.sam.id });
    await openJob(sam, { orderId: second.orderId, leadOriginId: (await leadOrigin('customer_referral')).id });
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
  it('shows a funnel that only narrows, and counts the orders that are paid for and not pushed yet', async () => {
    // A proposal and a deposit without anyone logging a call first.
    const { orderId } = await orderAt(w, 'DEPOSIT_PAID');
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).firstContactedAt).toBeNull();
    // A second order that has only been opened, and a third that is assigned and waiting.
    await orderAt(w, 'OPENED', { phone: '0400 555 666', email: 'second@example.com', address: '2 Other Rd' });
    await orderAt(w, 'ASSIGNED', { phone: '0400 555 777', email: 'third@example.com', address: '3 Other Rd' });

    const d = await getDashboard(as(w.manager, w.clock), { from: '2026-11-01', to: '2026-11-30' });
    const row = d.bySource.find((s) => s.name === 'Bluven website')!;
    expect(row).toMatchObject({ leads: 3, opened: 2, proposals: 1, deposits: 1 });
    expect(row.leads).toBeGreaterThanOrEqual(row.opened);
    expect(row.opened).toBeGreaterThanOrEqual(row.proposals);
    expect(row.proposals).toBeGreaterThanOrEqual(row.deposits);
    expect(d.totals).toMatchObject({ deposits: 1, accepted: 0, completed: 0, readyToPush: 1 });
  });

  it('counts jobs and deposits by where the customer came from, which is what partners are paid by', async () => {
    const partner = (await leadOrigin('partner')).id;
    // One of the website's, with a deposit; one of a partner's, accepted by operations; one of a partner's, only opened.
    await orderAt(w, 'DEPOSIT_PAID');
    const accepted = await orderAt(w, 'ACCEPTED', { phone: '0400 555 666', email: 'second@example.com', address: '2 Other Rd' });
    const opened = await orderAt(w, 'OPENED', { phone: '0400 555 777', email: 'third@example.com', address: '3 Other Rd' });
    await db.order.updateMany({ where: { id: { in: [accepted.orderId, opened.orderId] } }, data: { leadOriginId: partner } });
    // And one from before lead sources were asked for.
    const old = await orderAt(w, 'QUOTED', { phone: '0400 555 888', email: 'fourth@example.com', address: '4 Other Rd' });
    await db.order.update({ where: { id: old.orderId }, data: { leadOriginId: null } });

    const d = await getDashboard(as(w.manager, w.clock), { from: '2026-11-01', to: '2026-11-30' });
    const by = Object.fromEntries(d.byOrigin.map((o) => [o.label, o]));
    expect(by['Bluven website']).toMatchObject({ opened: 1, deposits: 1, depositValueCents: 900_000, completed: 0 });
    expect(by['Partner']).toMatchObject({ opened: 2, deposits: 1, depositValueCents: 900_000, completed: 0 });
    expect(by['Not recorded']).toMatchObject({ originId: null, opened: 1, deposits: 0 });
    // In the order the managers keep the list in, with what has no source at the end.
    expect(d.byOrigin.map((o) => o.label)).toEqual(['Bluven website', 'Partner', 'Not recorded']);
    // A salesperson sees their own.
    await db.order.update({ where: { id: opened.orderId }, data: { ownerId: w.alex.id } });
    const alex = await getDashboard(as(w.alex, w.clock), { from: '2026-11-01', to: '2026-11-30' });
    expect(alex.byOrigin).toEqual([expect.objectContaining({ label: 'Partner', opened: 1, deposits: 0 })]);
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
    // Four of Sam's orders, last touched 3, 6, 9 and 12 days ago, and one of Alex's, 9 days ago.
    const ids: Record<string, string> = {};
    for (const [name, days] of [['fresh', 3], ['five', 6], ['ten', 9], ['fifteen', 12]] as const) {
      const { orderId } = await orderAt(w, 'OPENED', { firstName: name, phone: `0400 10${days} 00${days}`.slice(0, 12), email: `${name}@example.com`, address: `${days} Idle St` });
      await db.order.update({ where: { id: orderId }, data: { lastStaffActivityAt: new Date(w.clock.now().getTime() - days * 86_400_000) } });
      ids[name] = orderId;
    }
    const other = await orderAt(w, 'OPENED', { firstName: 'alexs', phone: '0400 777 888', email: 'alexs@example.com', address: '1 Alex St' });
    await db.order.update({ where: { id: other.orderId }, data: { ownerId: w.alex.id, lastStaffActivityAt: new Date(w.clock.now().getTime() - 9 * 86_400_000) } });
    // The reminder job has not run: no reminder has gone out, and the figures do not wait for it.
    expect(await db.order.count({ where: { idleLevel: { gt: 0 } } })).toBe(0);

    const manager = as(w.manager, w.clock);
    const d = await getDashboard(manager, { from: '2026-11-01', to: '2026-11-30' });
    expect(d.idleDays).toEqual([5, 8, 10]);
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

    // An order on hold, or one waiting for operations, is not idle however long it sits.
    await holdOrder(as(w.sam, w.clock), { orderId: ids.ten!, until: parseDateOnly('2026-12-20'), note: 'travelling' });
    expect((await getDashboard(manager, { from: '2026-11-01', to: '2026-11-30' })).totals.idle).toEqual([3, 2, 1]);
    const row = await db.order.findUniqueOrThrow({ where: { id: ids.ten } });
    expect(idleTier(row, w.clock.now(), { remindOwnerDays: 5, remindManagerDays: 8, returnToPoolDays: 10 })).toBe(0);
  });
});

describe('the report over time', () => {
  it('shows twelve calendar months, and how long enquiries take to become deposits', async () => {
    const sourceId = (await source('bluven-website')).id;
    const at = (iso: string) => systemCtx(db, 'Bluven website', () => new Date(iso));
    // The clock stands at 10 November 2026. One enquiry in September, two in November.
    await ingestLeads(at('2026-09-15T02:00:00Z'), [lead({ externalId: 'sep', phone: '0400 000 011', email: 'sep@example.com', address: '1 Sep St' })], { sourceId, requireExternalId: true });
    // 31 October 23:30 in Sydney is still October there, although it is 12:30 UTC.
    await ingestLeads(at('2026-10-31T12:30:00Z'), [lead({ externalId: 'oct', phone: '0400 000 012', email: 'oct@example.com', address: '1 Oct St' })], { sourceId, requireExternalId: true });
    // 1 November 00:30 in Sydney is 13:30 UTC on 31 October.
    await ingestLeads(at('2026-10-31T13:30:00Z'), [lead({ externalId: 'nov', phone: '0400 000 013', email: 'nov@example.com', address: '1 Nov St' })], { sourceId, requireExternalId: true });
    // A deposit recorded the day of the enquiry: zero days.
    await orderAt(w, 'DEPOSIT_PAID');
    // And one for the September enquiry on 5 October, twenty days on. A deposit dated before its enquiry would count as the same day, never as a negative number.
    const sep = await db.order.findFirstOrThrow({ where: { externalLeadId: 'sep' } });
    await db.order.update({ where: { id: sep.id }, data: { depositAt: new Date('2026-10-05T02:00:00Z'), ownerId: w.sam.id } });

    const d = await getDashboard(as(w.manager, w.clock), { from: '2026-09-01', to: '2026-11-30' });
    expect(d.monthly).toHaveLength(12);
    expect(d.monthly[0]!.month).toBe('2025-12');
    expect(d.monthly.slice(-3)).toEqual([
      { month: '2026-09', leads: 1, deposits: 0, accepted: 0, completed: 0, lost: 0 },
      { month: '2026-10', leads: 1, deposits: 1, accepted: 0, completed: 0, lost: 0 },
      { month: '2026-11', leads: 2, deposits: 1, accepted: 0, completed: 0, lost: 0 },
    ]);
    // 15 September to 5 October is 20 days; the other deposit came the day of the enquiry.
    const row = d.bySource.find((s) => s.name === 'Bluven website')!;
    expect(row).toMatchObject({ leads: 4, deposits: 2, avgDaysToDeposit: 10 });
    expect(d.totals.avgDaysToDeposit).toBe(10);
    // Only the deposits of the chosen period count towards the average.
    expect((await getDashboard(as(w.manager, w.clock), { from: '2026-10-01', to: '2026-10-31' })).totals.avgDaysToDeposit).toBe(20);
    expect((await getDashboard(as(w.manager, w.clock), { from: '2026-08-01', to: '2026-08-31' })).totals.avgDaysToDeposit).toBeNull();

    const oct = await db.order.findFirstOrThrow({ where: { externalLeadId: 'oct' } });
    await markLost(as(w.manager, w.clock), { orderId: oct.id, reasonId: (await db.lostReason.findFirstOrThrow({ where: { key: 'price' } })).id });
    expect((await getDashboard(as(w.manager, w.clock), { from: '2026-09-01', to: '2026-11-30' })).monthly.at(-1)).toMatchObject({ month: '2026-11', lost: 1 });
  });

  it('keeps to the edges of the twelve months and of the eight weeks, as the days fall in Sydney', async () => {
    const sourceId = (await source('bluven-website')).id;
    const add = (id: string, n: number, iso: string) =>
      ingestLeads(systemCtx(db, 'Bluven website', () => new Date(iso)), [lead({ externalId: id, phone: `0400 000 02${n}`, email: `${id}@example.com`, address: `${n} Edge St` })], { sourceId, requireExternalId: true });
    // The clock stands at Tuesday 10 November 2026: the months shown are December 2025 to November 2026.
    await add('first-month', 1, '2025-11-30T13:30:00Z'); // 1 December 2025, 00:30 in Sydney
    await add('month-before', 2, '2025-11-30T12:30:00Z'); // 30 November 2025, 23:30
    // The weeks shown start on Mondays, from 21 September to 9 November.
    await add('first-week', 3, '2026-09-20T14:30:00Z'); // Monday 21 September, 00:30
    await add('week-before', 4, '2026-09-20T13:30:00Z'); // Sunday 20 September, 23:30

    const d = await getDashboard(as(w.manager, w.clock), { from: '2026-11-01', to: '2026-11-30' });
    expect(d.monthly[0]).toEqual({ month: '2025-12', leads: 1, deposits: 0, accepted: 0, completed: 0, lost: 0 });
    // The one from November 2025 is in no month; both from September 2026 are in theirs.
    expect(d.monthly.map((m) => m.leads).reduce((a, b) => a + b)).toBe(3);
    expect(d.monthly.find((m) => m.month === '2026-09')).toMatchObject({ leads: 2 });
    expect(d.weekly.map((x) => x.weekStart)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    expect(d.weekly[0]).toEqual({ weekStart: '2026-09-21', leads: 1, deposits: 0 });
    expect(d.weekly.map((x) => x.leads).reduce((a, b) => a + b)).toBe(1);
    // A salesperson's own report counts only their orders, in the same periods.
    expect((await getDashboard(as(w.sam, w.clock), { from: '2026-11-01', to: '2026-11-30' })).monthly.every((m) => m.leads === 0)).toBe(true);
  });

  it('counts the jobs operations accepted and the ones that were closed, each in its month', async () => {
    await orderAt(w, 'ACCEPTED');
    const closed = await orderAt(w, 'INSTALLED', { phone: '0400 555 666', email: 'second@example.com', address: '2 Other Rd' });
    await confirmFinalPayment(as(w.fin, w.clock), { orderId: closed.orderId, amountCents: 810_000 });
    const d = await getDashboard(as(w.manager, w.clock), { from: '2026-11-01', to: '2026-11-30' });
    expect(d.totals).toMatchObject({ deposits: 2, accepted: 2, completed: 1, readyToPush: 0 });
    expect(d.monthly.at(-1)).toEqual({ month: '2026-11', leads: 2, deposits: 2, accepted: 2, completed: 1, lost: 0 });
    // Neither is in anyone's pipeline any more.
    expect(d.bySalesperson.find((p) => p.userId === w.sam.id)).toMatchObject({ open: 0, depositsInRange: 2 });
    expect((await listPipelineOrders(as(w.sam, w.clock), { view: 'active' })).total).toBe(0);
    expect((await listPipelineOrders(as(w.sam, w.clock), { view: 'operations' })).total).toBe(1);
    expect((await listPipelineOrders(as(w.sam, w.clock), { view: 'completed' })).rows.map((r) => r.id)).toEqual([closed.orderId]);
  });

  it('exports the orders of a period, a page at a time: all of them for a manager, their own for a salesperson', async () => {
    const mine = await orderAt(w, 'DEPOSIT_PAID');
    const second = await orderAt(w, 'OPENED', { firstName: 'Bo', phone: '0400 555 666', email: 'bo@example.com', address: '2 Other Rd' });
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
    expect(row).toMatchObject({ customerName: 'Jane Smith', address: '12 Sample St, Parramatta NSW 2150', stage: 'DEPOSIT_PAID', source: { name: 'Bluven website' }, leadOrigin: { label: 'Bluven website' }, owner: { name: 'Sam Sales' } });
    expect(row.quotes[0]).toMatchObject({ dcWatts: 6600, totalCents: 900_000 });
    expect(row.deposits[0]).toMatchObject({ amountCents: 90_000, status: 'PENDING' });
    expect(row.openedAt).not.toBeNull();
    expect(row.depositAt).not.toBeNull();

    expect((await collect(as(w.sam, w.clock))).rows.map((r) => r.id)).toEqual([mine.orderId]);
    expect(await countReportOrders(as(w.sam, w.clock), { from: '2026-10-01', to: '2026-10-31' })).toBe(0);
    // Finance and operations have no report of the pipeline.
    await expect(countReportOrders(as(w.fin, w.clock), range)).rejects.toThrow('not allowed');
    await expect(collect(as(w.ops, w.clock))).rejects.toThrow('not allowed');
  });
});
