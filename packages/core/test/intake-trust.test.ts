// Intake rules that protect leads and customers: a bad row fails alone, imported history does not
// swallow new enquiries, outside sources learn and change little, and a salesperson can only add
// to their own customers.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateLeadError,
  assignOrders,
  createLeadManually,
  createLeadSource,
  ingestLeads,
  listUnassignedOrders,
  markLost,
  matchCustomer,
  returnOrdersToPool,
  systemCtx,
  updateCustomer,
  updateUser,
} from '../src';
import { as, lead, makeUser, resetDb, source, testDb, type TestUser } from './helpers';

const db = testDb();
let admin: TestUser;
let manager: TestUser;
let sam: TestUser;
let alex: TestUser;
let bluvenId: string;

const ingest = (leads: unknown[], opts: { backfill?: boolean; dryRun?: boolean; trusted?: boolean; sourceId?: string } = {}) =>
  ingestLeads(systemCtx(db, 'Intake'), leads, { sourceId: bluvenId, requireExternalId: true, ...opts });
const manual = (who: TestUser, over: Record<string, unknown> = {}) => createLeadManually(as(who), lead({ externalId: undefined, ...over }));

beforeEach(async () => {
  await resetDb();
  admin = await makeUser(['ADMIN'], 'Ada Admin');
  manager = await makeUser(['MANAGER'], 'Morgan Manager');
  sam = await makeUser(['SALES'], 'Sam Sales');
  alex = await makeUser(['SALES'], 'Alex Sales');
  bluvenId = (await source('bluven-website')).id;
});

describe('imported history and new enquiries', () => {
  it('moves an untouched historic order into the pool when the person asks again', async () => {
    const history = await ingest([lead({ externalId: 'h1', createdAt: '2025-03-01T09:00:00+11:00' })], { backfill: true });
    const orderId = history.results[0]!.id!;
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).isBackfill).toBe(true);
    expect(await db.notification.count()).toBe(0);
    expect((await listUnassignedOrders(as(manager), {})).rows.map((o) => o.id)).toEqual([]);

    const live = await ingest([lead({ externalId: 'web-900', notes: 'Ready to go ahead now.' })]);
    // Same order, not a second one…
    expect(live.results[0]).toMatchObject({ status: 'duplicate', id: orderId });
    expect(await db.order.count()).toBe(1);
    // …but it now waits in the pool and the managers are told, exactly as for a new lead.
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).isBackfill).toBe(false);
    expect((await listUnassignedOrders(as(manager), {})).rows.map((o) => o.id)).toEqual([orderId]);
    const notes = await db.notification.findMany();
    expect(notes.map((n) => [n.userId, n.type])).toEqual([[manager.id, 'pool.new_leads']]);
    expect(await db.activity.count({ where: { orderId, summary: { contains: 'Repeat enquiry' } } })).toBe(1);
  });

  it('leaves history alone while more history is being loaded', async () => {
    await ingest([lead({ externalId: 'h1', createdAt: '2025-03-01T09:00:00+11:00' })], { backfill: true });
    const more = await ingest([lead({ externalId: 'h2', createdAt: '2025-06-01T09:00:00+10:00' })], { backfill: true });
    expect(more.results[0]!.status).toBe('duplicate');
    expect((await db.order.findFirstOrThrow()).isBackfill).toBe(true);
    expect(await db.notification.count()).toBe(0);
  });

  it('sends a historic order to the pool, not back to history, once it has been worked', async () => {
    const history = await ingest([lead({ externalId: 'h1', createdAt: '2025-03-01T09:00:00+11:00' })], { backfill: true });
    const orderId = history.results[0]!.id!;
    await assignOrders(as(manager), { orderIds: [orderId], ownerId: sam.id });
    await returnOrdersToPool(as(manager), { orderIds: [orderId], note: 'Sam is away' });
    expect((await listUnassignedOrders(as(manager), {})).rows.map((o) => o.id)).toEqual([orderId]);
  });
});

describe('one bad row', () => {
  it('cleans characters the database cannot hold instead of losing the lead', async () => {
    const res = await ingest([lead({ externalId: 'x1', firstName: 'Ja\u0000ne', notes: 'Half an emoji \ud83d and a bell \u0007 here.\nSecond line.', sourceDetail: 'form\u0000', attribution: { utmSource: 'news\u0000letter' } })]);
    expect(res).toMatchObject({ created: 1, failed: 0 });
    const order = await db.order.findUniqueOrThrow({ where: { id: res.results[0]!.id! }, include: { customer: true } });
    expect(order.customer.firstName).toBe('Jane');
    expect((order.leadDetails as { notes: string }).notes).toBe('Half an emoji � and a bell  here.\nSecond line.');
    expect(order.sourceDetail).toBe('form');
    expect(order.attribution).toEqual({ utmSource: 'newsletter' });
  });

  it('rejects a date the calendar does not have, for that row only', async () => {
    const res = await ingest([lead({ externalId: 'a' }), lead({ externalId: 'b', phone: '0400 000 002', email: 'b@example.com', createdAt: '0000-01-01T00:00:00Z' }), lead({ externalId: 'c', phone: '0400 000 003', email: 'c@example.com' })]);
    expect(res).toMatchObject({ received: 3, created: 2, failed: 1 });
    expect(res.results[1]).toEqual({ index: 1, ok: false, error: 'createdAt: must not be before the year 2000' });
  });

  it('fails alone when the database refuses its data, and the rows after it still go in', async () => {
    await db.$executeRawUnsafe(`CREATE FUNCTION test_poison() RETURNS trigger AS $$ BEGIN IF NEW."firstName" = 'Poison' THEN RAISE EXCEPTION 'value the database cannot hold' USING ERRCODE = '22000'; END IF; IF NEW."firstName" = 'Outage' THEN RAISE EXCEPTION 'the database is having a bad day' USING ERRCODE = '57014'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER test_poison_t BEFORE INSERT ON "Customer" FOR EACH ROW EXECUTE FUNCTION test_poison()`);
    try {
      const batch = [lead({ externalId: 'a' }), lead({ externalId: 'b', firstName: 'Poison', phone: '0400 000 002', email: 'b@example.com' }), lead({ externalId: 'c', phone: '0400 000 003', email: 'c@example.com' })];
      const res = await ingest(batch);
      expect(res).toMatchObject({ received: 3, created: 2, failed: 1 });
      expect(res.results[1]).toEqual({ index: 1, ok: false, error: 'lead: contains data that cannot be stored' });
      expect(res.results[2]).toMatchObject({ ok: true, status: 'created' });
      // Sending the batch again reports what was stored and still isolates the bad row.
      expect(await ingest(batch)).toMatchObject({ alreadyReceived: 2, failed: 1 });

      // Anything that is not about the row's own data still fails the request, so the sender retries it.
      await expect(ingest([lead({ externalId: 'd', firstName: 'Outage', phone: '0400 000 004', email: 'd@example.com' })])).rejects.toThrow();
      expect(await db.order.count()).toBe(2);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER test_poison_t ON "Customer"`);
      await db.$executeRawUnsafe(`DROP FUNCTION test_poison()`);
    }
  });
});

describe('a source that is not one of our own systems', () => {
  it('is told a lead is a repeat, but not which order, and cannot change the customer', async () => {
    const first = await ingest([lead({ externalId: 'web-1' })]);
    const vendor = await createLeadSource(as(admin), { name: 'Lead vendor', kind: 'EXTERNAL' });
    const res = await ingest([lead({ externalId: 'v-1', phone: '0412 345 678', email: 'someone.else@vendor.example', notes: 'Bought lead' })], { sourceId: vendor.id, trusted: false });

    expect(res.results[0]).toEqual({ index: 0, ok: true, status: 'duplicate', id: null, orderNo: null });
    // The enquiry is on the timeline for the salesperson to read…
    expect(await db.activity.count({ where: { orderId: first.results[0]!.id!, summary: 'Repeat enquiry received via Lead vendor' } })).toBe(1);
    // …but the vendor's email was not attached to our customer.
    expect((await db.customerEmail.findMany()).map((e) => e.email)).toEqual(['jane@example.com']);
    // Asking again does not reveal it either.
    expect((await ingest([lead({ externalId: 'v-1' })], { sourceId: vendor.id, trusted: false })).results[0]).toEqual({ index: 0, ok: true, status: 'already_received', id: null, orderNo: null });
  });

  it('gets the reference of orders its own leads created', async () => {
    const vendor = await createLeadSource(as(admin), { name: 'Lead vendor', kind: 'EXTERNAL' });
    const res = await ingest([lead({ externalId: 'v-2' })], { sourceId: vendor.id, trusted: false });
    expect(res.results[0]).toMatchObject({ status: 'created', orderNo: expect.stringMatching(/^BLV-/) });
    expect((await ingest([lead({ externalId: 'v-2' })], { sourceId: vendor.id, trusted: false })).results[0]).toMatchObject({ status: 'already_received', id: res.results[0]!.id });
  });
});

describe('who a repeat enquiry is announced to', () => {
  it('goes to the managers when the salesperson has left', async () => {
    const first = await ingest([lead({ externalId: 'a' })]);
    await assignOrders(as(manager), { orderIds: [first.results[0]!.id!], ownerId: sam.id });
    await updateUser(as(admin), { userId: sam.id, name: sam.name, roles: ['SALES'], isActive: false });
    await db.notification.deleteMany();
    await ingest([lead({ externalId: 'b' })]);
    expect((await db.notification.findMany({ where: { type: 'lead.duplicate' } })).map((n) => n.userId)).toEqual([manager.id]);
  });
});

describe('a salesperson entering leads', () => {
  it('can open a second order for their own customer at another address', async () => {
    const first = await manual(sam);
    const second = await manual(sam, { address: '9 Harbour Rd', suburb: 'Manly', postcode: '2095' });
    expect(second.status).toBe('created');
    expect(second.orderId).not.toBe(first.orderId);
    const orders = await db.order.findMany({ orderBy: { createdAt: 'asc' }, include: { property: true } });
    expect(orders.map((o) => [o.ownerId, o.property.addressLine1])).toEqual([[sam.id, '12 Sample St'], [sam.id, '9 Harbour Rd']]);
    expect(await db.customer.count()).toBe(1);
    // The same address again is still pointed at the order that exists.
    await expect(manual(sam, { address: '9 Harbour Road', suburb: 'Manly', postcode: '2095' })).rejects.toMatchObject({ orderId: second.orderId });
  });

  it('is refused when the customer has an order in progress with somebody else, even if the latest order is theirs', async () => {
    // Alex has an open order for Jane; Sam handled a newer one for another address, now lost.
    const alexOrder = await manual(alex);
    const forSam = await createLeadManually(as(manager), lead({ externalId: undefined, address: '9 Harbour Rd', suburb: 'Manly', postcode: '2095' }), { ownerId: sam.id });
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await markLost(as(sam), { orderId: forSam.orderId, reasonId: reason.id });

    // Without an address the lead would have been merged into Alex's order.
    const attempt = manual(sam, { address: undefined, suburb: undefined, postcode: undefined, state: undefined });
    await expect(attempt).rejects.toBeInstanceOf(DuplicateLeadError);
    await expect(attempt).rejects.toMatchObject({ orderId: undefined, message: expect.stringContaining('not assigned to you') });
    expect(await db.activity.count({ where: { orderId: alexOrder.orderId, summary: { contains: 'Repeat enquiry' } } })).toBe(0);
    expect(await db.order.count()).toBe(2);
  });
});

describe('contact details that belong to another customer', () => {
  async function twoCustomers() {
    const mine = await manual(sam);
    const theirs = await manual(alex, { firstName: 'Bob', lastName: 'Brown', phone: '0433 111 222', email: 'bob@example.com', address: '1 Other St' });
    return { mine, theirs };
  }

  it('cannot be added by a salesperson', async () => {
    const { mine } = await twoCustomers();
    const base = { orderId: mine.orderId, firstName: 'Jane', lastName: 'Smith', notes: '' };
    await expect(updateCustomer(as(sam), { ...base, phones: ['0412 345 678', '0433 111 222'], emails: ['jane@example.com'] })).rejects.toMatchObject({
      fieldErrors: { 'phones.1': expect.stringContaining('another customer') },
    });
    await expect(updateCustomer(as(sam), { ...base, phones: ['0412 345 678'], emails: ['jane@example.com', 'BOB@example.com'] })).rejects.toMatchObject({
      fieldErrors: { 'emails.1': expect.stringContaining('another customer') },
    });
    // Their own details, and new ones nobody has, are fine.
    await updateCustomer(as(sam), { ...base, phones: ['0412 345 678', '02 9000 1111'], emails: ['jane@example.com', 'jane.work@example.com'] });
    // And nobody collects a long list.
    await expect(updateCustomer(as(sam), { ...base, phones: Array.from({ length: 7 }, (_, i) => `0400 100 10${i}`), emails: [] })).rejects.toMatchObject({ fieldErrors: { 'phones.6': expect.stringContaining('at most 6') } });
  });

  it('can be added by a manager, and enquiries still go to whoever had the number first', async () => {
    const { mine, theirs } = await twoCustomers();
    await updateCustomer(as(manager), { orderId: mine.orderId, firstName: 'Jane', lastName: 'Smith', notes: '', phones: ['0412 345 678', '0433 111 222'], emails: ['jane@example.com'] });
    const bob = (await db.order.findUniqueOrThrow({ where: { id: theirs.orderId } })).customerId;
    expect((await matchCustomer(db, '+61433111222', undefined)).customerId).toBe(bob);
    // A website enquiry from Bob's number lands on Bob's order, with Alex.
    const res = await ingest([lead({ externalId: 'web-7', firstName: 'Bob', phone: '0433 111 222', email: undefined, address: '1 Other St' })]);
    expect(res.results[0]).toMatchObject({ status: 'duplicate', id: theirs.orderId });
  });
});

describe('matching details', () => {
  it('recognises a local landline as the same number written in full, using the state', async () => {
    const first = await ingest([lead({ externalId: 'a', phone: '(02) 9123 4567', email: undefined })]);
    const again = await ingest([lead({ externalId: 'b', phone: '9123 4567', email: undefined, state: 'NSW' })]);
    expect(again.results[0]).toMatchObject({ status: 'duplicate', id: first.results[0]!.id });
    // The same digits in another state are somebody else.
    const melbourne = await ingest([lead({ externalId: 'c', phone: '9123 4567', email: undefined, address: '5 Yarra St', suburb: 'Richmond', state: 'VIC', postcode: '3121' })]);
    expect(melbourne.results[0]!.status).toBe('created');
    expect(await db.customer.count()).toBe(2);
  });

  it('finds the open order when the same address is on file twice', async () => {
    const first = await ingest([lead({ externalId: 'a' })]);
    const orderId = first.results[0]!.id!;
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    // A second entry for the same address, created earlier than the one the order uses.
    await db.property.create({ data: { id: 'prp_twin', customerId: order.customerId, addressLine1: '12 Sample Street', suburb: 'Parramatta', state: 'NSW', postcode: '2150', addressKey: '12 sample st|parramatta|2150', createdAt: new Date('2020-01-01T00:00:00Z') } });
    const again = await ingest([lead({ externalId: 'b' })]);
    expect(again.results[0]).toMatchObject({ status: 'duplicate', id: orderId });
    expect(await db.order.count()).toBe(1);
  });
});
