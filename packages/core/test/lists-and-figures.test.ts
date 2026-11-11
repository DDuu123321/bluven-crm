// Lists and figures that have to agree with what they stand for: the operations inbox, the
// dashboard, and a few rules around returned orders and moved properties.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_DOCUMENT,
  createLeadManually,
  getDashboard,
  holdOrder,
  ingestLeads,
  listHandoffs,
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
