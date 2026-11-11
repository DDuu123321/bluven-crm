import { beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateLeadError,
  ValidationError,
  assignOrders,
  checkLeadDuplicate,
  createLeadManually,
  importLeadCsv,
  ingestLeads,
  markLost,
  parseLeadCsv,
  systemCtx,
} from '../src';
import { as, lead, makeUser, resetDb, source, testDb, type TestUser } from './helpers';

const db = testDb();
let manager: TestUser;
let sam: TestUser;
let alex: TestUser;
let bluvenId: string;

function intakeCtx() {
  return systemCtx(db, 'Bluven website');
}
async function ingest(leads: unknown[], opts: { backfill?: boolean; dryRun?: boolean } = {}) {
  return ingestLeads(intakeCtx(), leads, { sourceId: bluvenId, requireExternalId: true, ...opts });
}

beforeEach(async () => {
  await resetDb();
  manager = await makeUser(['MANAGER'], 'Morgan Manager');
  sam = await makeUser(['SALES'], 'Sam Sales');
  alex = await makeUser(['SALES'], 'Alex Sales');
  bluvenId = (await source('bluven-website')).id;
});

describe('lead intake', () => {
  it('creates customer, property and order for a new person and puts the order in the pool', async () => {
    const res = await ingest([lead({ externalId: '1042' })]);
    expect(res).toMatchObject({ received: 1, created: 1, alreadyReceived: 0, duplicates: 0, failed: 0 });
    const item = res.results[0]!;
    expect(item).toMatchObject({ index: 0, ok: true, status: 'created' });
    expect(item.orderNo).toMatch(/^BLV-\d{4}-00001$/);

    const order = await db.order.findUniqueOrThrow({
      where: { id: item.id! },
      include: { customer: { include: { phones: true, emails: true } }, property: true, activities: true },
    });
    expect(order).toMatchObject({ stage: 'NEW', sideState: 'NONE', ownerId: null, externalLeadId: '1042', isBackfill: false });
    expect(order.customer).toMatchObject({ firstName: 'Jane', lastName: 'Smith' });
    expect(order.customer.phones.map((p) => p.normalized)).toEqual(['+61412345678']);
    expect(order.customer.emails.map((e) => e.email)).toEqual(['jane@example.com']);
    expect(order.property).toMatchObject({ addressLine1: '12 Sample St', suburb: 'Parramatta', state: 'NSW', postcode: '2150', addressKey: '12 sample st|parramatta|2150' });
    expect(order.leadDetails).toEqual({ components: ['Solar', 'Battery'], monthlyBill: 350 });
    expect(order.activities.map((a) => a.summary)).toEqual(['Lead received via Bluven website']);

    // Managers hear about it once.
    const notes = await db.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: manager.id, type: 'pool.new_leads', href: '/orders/unassigned' });
  });

  it('is idempotent on the external id', async () => {
    const first = await ingest([lead({ externalId: 'A1' })]);
    const again = await ingest([lead({ externalId: 'A1', firstName: 'Changed' })]);
    expect(again.results[0]).toMatchObject({ ok: true, status: 'already_received', id: first.results[0]!.id, orderNo: first.results[0]!.orderNo });
    expect(await db.order.count()).toBe(1);
    expect(await db.customer.count()).toBe(1);
  });

  it('merges a repeat enquiry into the open order instead of creating another one', async () => {
    const first = await ingest([lead({ externalId: 'A1' })]);
    await assignOrders(as(manager), { orderIds: [first.results[0]!.id!], ownerId: sam.id });
    await db.notification.deleteMany();

    // Same person (phone written differently), same address (written differently), new external id.
    const second = await ingest([lead({ externalId: 'A2', phone: '+61 412 345 678', email: 'jane.work@example.com', address: '12 Sample Street', notes: 'Wants a call back' })]);
    expect(second.results[0]).toMatchObject({ ok: true, status: 'duplicate', id: first.results[0]!.id });
    expect(second).toMatchObject({ created: 0, duplicates: 1 });
    expect(await db.order.count()).toBe(1);

    const activities = await db.activity.findMany({ where: { orderId: first.results[0]!.id!, type: 'LEAD' }, orderBy: { createdAt: 'asc' } });
    expect(activities.map((a) => a.summary)).toEqual(['Lead received via Bluven website', 'Repeat enquiry received via Bluven website']);
    // The new email address is remembered.
    expect((await db.customerEmail.findMany({ orderBy: { createdAt: 'asc' } })).map((e) => e.email)).toEqual(['jane@example.com', 'jane.work@example.com']);
    // The owner is told, not the managers.
    const notes = await db.notification.findMany();
    expect(notes.map((n) => [n.userId, n.type])).toEqual([[sam.id, 'lead.duplicate']]);
    // Sending the duplicate again is recognised as already received.
    expect((await ingest([lead({ externalId: 'A2' })])).results[0]).toMatchObject({ status: 'already_received', id: first.results[0]!.id });
  });

  it('opens a new order for a known customer at a new address and gives it to their salesperson', async () => {
    const first = await ingest([lead({ externalId: 'A1' })]);
    await assignOrders(as(manager), { orderIds: [first.results[0]!.id!], ownerId: sam.id });
    const second = await ingest([lead({ externalId: 'A2', address: '9 Beach Rd', suburb: 'Manly', postcode: '2095' })]);
    expect(second.results[0]).toMatchObject({ status: 'created' });
    const order = await db.order.findUniqueOrThrow({ where: { id: second.results[0]!.id! } });
    expect(order.ownerId).toBe(sam.id);
    expect(order.assignedAt).not.toBeNull();
    expect(await db.customer.count()).toBe(1);
    expect(await db.property.count()).toBe(2);
  });

  it('opens a new order when the earlier one at the same address is finished', async () => {
    const first = await ingest([lead({ externalId: 'A1' })]);
    const firstId = first.results[0]!.id!;
    await assignOrders(as(manager), { orderIds: [firstId], ownerId: sam.id });
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await markLost(as(sam), { orderId: firstId, reasonId: reason.id });

    const second = await ingest([lead({ externalId: 'A2' })]);
    expect(second.results[0]).toMatchObject({ status: 'created' });
    const order = await db.order.findUniqueOrThrow({ where: { id: second.results[0]!.id! } });
    expect(order.propertyId).toBe((await db.order.findUniqueOrThrow({ where: { id: firstId } })).propertyId);
    expect(order.ownerId).toBe(sam.id);
    expect(await db.property.count()).toBe(1);
  });

  it('sends a returning customer to the pool when their salesperson has left', async () => {
    const first = await ingest([lead({ externalId: 'A1' })]);
    await assignOrders(as(manager), { orderIds: [first.results[0]!.id!], ownerId: sam.id });
    await db.user.update({ where: { id: sam.id }, data: { isActive: false } });
    const second = await ingest([lead({ externalId: 'A2', address: '9 Beach Rd', suburb: 'Manly', postcode: '2095' })]);
    expect((await db.order.findUniqueOrThrow({ where: { id: second.results[0]!.id! } })).ownerId).toBeNull();
  });

  it('handles enquiries without an address', async () => {
    // First contact has no address at all.
    const first = await ingest([lead({ externalId: 'A1', address: undefined, suburb: undefined, state: undefined, postcode: undefined })]);
    const firstOrder = await db.order.findUniqueOrThrow({ where: { id: first.results[0]!.id! }, include: { property: true } });
    expect(firstOrder.property.addressLine1).toBe('');
    expect(firstOrder.property.addressKey).toBeNull();

    // A second enquiry without an address joins the open order.
    const second = await ingest([lead({ externalId: 'A2', address: undefined, suburb: undefined, state: undefined, postcode: undefined })]);
    expect(second.results[0]).toMatchObject({ status: 'duplicate', id: firstOrder.id });

    // A third one that brings the address fills it in on the only property and still joins the open order.
    const third = await ingest([lead({ externalId: 'A3' })]);
    expect(third.results[0]).toMatchObject({ status: 'duplicate', id: firstOrder.id });
    const property = await db.property.findUniqueOrThrow({ where: { id: firstOrder.propertyId } });
    expect(property).toMatchObject({ addressLine1: '12 Sample St', suburb: 'Parramatta', postcode: '2150', addressKey: '12 sample st|parramatta|2150' });
    expect(await db.property.count()).toBe(1);
  });

  it('flags, but does not merge, a different person at the same address', async () => {
    const first = await ingest([lead({ externalId: 'A1' })]);
    const second = await ingest([lead({ externalId: 'A2', firstName: 'John', phone: '0499 111 222', email: 'john@example.com', address: '12 Sample Street' })]);
    expect(second.results[0]).toMatchObject({ status: 'created' });
    expect(await db.customer.count()).toBe(2);
    const order = await db.order.findUniqueOrThrow({ where: { id: second.results[0]!.id! } });
    expect(order.possibleDuplicateOfId).toBe(first.results[0]!.id);
  });

  it('prefers the phone match when phone and email point at different customers', async () => {
    const a = await ingest([lead({ externalId: 'A1', phone: '0411 111 111', email: 'a@example.com' })]);
    const b = await ingest([lead({ externalId: 'B1', firstName: 'Bob', phone: '0422 222 222', email: 'b@example.com', address: '5 Other St' })]);
    // Phone of A, email of B, at a new address.
    const c = await ingest([lead({ externalId: 'C1', phone: '0411 111 111', email: 'b@example.com', address: '77 New Ave', suburb: 'Ryde', postcode: '2112' })]);
    const order = await db.order.findUniqueOrThrow({ where: { id: c.results[0]!.id! } });
    const orderA = await db.order.findUniqueOrThrow({ where: { id: a.results[0]!.id! } });
    expect(order.customerId).toBe(orderA.customerId);
    expect(order.possibleDuplicateOfId).toBe(b.results[0]!.id);
  });

  it('reports invalid rows without affecting the rest of the batch', async () => {
    const res = await ingest([lead({ externalId: 'ok-1' }), lead({ externalId: 'bad', state: 'New South Wales' }), { firstName: 'NoPhone', externalId: 'x' }, lead({ externalId: 'ok-2', firstName: 'Zed', phone: '0433 333 333', email: 'z@example.com', address: '1 Z St' })]);
    expect(res).toMatchObject({ received: 4, created: 2, failed: 2 });
    expect(res.results[1]).toEqual({ index: 1, ok: false, error: 'state: must be one of NSW, VIC, QLD, SA, WA, TAS, ACT, NT' });
    expect(res.results[2]).toEqual({ index: 2, ok: false, error: 'phone: is required' });
    expect(await db.order.count()).toBe(2);
  });

  it('requires an external id from API callers', async () => {
    const res = await ingest([lead({ externalId: undefined })]);
    expect(res.results[0]).toEqual({ index: 0, ok: false, error: 'externalId: is required' });
  });

  it('predicts the outcome on a dry run and writes nothing', async () => {
    await ingest([lead({ externalId: 'A1' })]);
    const before = { orders: await db.order.count(), activities: await db.activity.count(), receipts: await db.leadReceipt.count(), audit: await db.auditLog.count() };
    const res = await ingest(
      [lead({ externalId: 'A1' }), lead({ externalId: 'A2' }), lead({ externalId: 'N1', firstName: 'New', phone: '0455 555 555', email: 'new@example.com', address: '3 New St' }), lead({ externalId: 'bad', postcode: '21' })],
      { dryRun: true },
    );
    expect(res.results.map((r) => r.status ?? r.error)).toEqual(['already_received', 'duplicate', 'created', 'postcode: must be 4 digits']);
    expect(res.results[2]).toMatchObject({ ok: true, id: null, orderNo: null });
    expect({ orders: await db.order.count(), activities: await db.activity.count(), receipts: await db.leadReceipt.count(), audit: await db.auditLog.count() }).toEqual(before);
  });

  it('imports history quietly in backfill mode', async () => {
    const res = await ingest([lead({ externalId: 'H1', createdAt: '2025-03-01T09:00:00+11:00' })], { backfill: true });
    const order = await db.order.findUniqueOrThrow({ where: { id: res.results[0]!.id! }, include: { activities: true } });
    expect(order).toMatchObject({ isBackfill: true, ownerId: null });
    expect(order.leadCreatedAt.toISOString()).toBe('2025-02-28T22:00:00.000Z');
    expect(order.activities[0]!.occurredAt.toISOString()).toBe('2025-02-28T22:00:00.000Z');
    expect(await db.notification.count()).toBe(0);
  });

  it('numbers orders sequentially', async () => {
    const res = await ingest([
      lead({ externalId: '1', phone: '0411 000 001', email: 'a1@example.com', address: '1 A St' }),
      lead({ externalId: '2', phone: '0411 000 002', email: 'a2@example.com', address: '2 A St' }),
      lead({ externalId: '3', phone: '0411 000 003', email: 'a3@example.com', address: '3 A St' }),
    ]);
    expect(res.results.map((r) => r.orderNo!.slice(-5))).toEqual(['00001', '00002', '00003']);
  });

  it('refuses a switched-off source', async () => {
    await db.leadSource.update({ where: { id: bluvenId }, data: { isActive: false } });
    await expect(ingest([lead()])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('manual entry', () => {
  it('makes the salesperson the owner of what they enter', async () => {
    const res = await createLeadManually(as(sam), lead({ externalId: undefined }));
    expect(res.status).toBe('created');
    const order = await db.order.findUniqueOrThrow({ where: { id: res.orderId }, include: { source: true } });
    expect(order.ownerId).toBe(sam.id);
    expect(order.source.key).toBe('manual');
    // Nobody needs to assign it, so managers are not paged.
    expect(await db.notification.count({ where: { type: 'pool.new_leads' } })).toBe(0);
  });

  it('never tells a salesperson about a colleague’s customer', async () => {
    await createLeadManually(as(sam), lead({ externalId: undefined }));
    expect(await checkLeadDuplicate(as(alex), { phone: '0412345678' })).toEqual({ level: 'other' });
    expect(await checkLeadDuplicate(as(alex), { email: 'JANE@example.com' })).toEqual({ level: 'other' });
    const attempt = createLeadManually(as(alex), lead({ externalId: undefined, firstName: 'Janet' }));
    await expect(attempt).rejects.toBeInstanceOf(DuplicateLeadError);
    await expect(attempt).rejects.toMatchObject({ orderId: undefined, message: expect.stringContaining('not assigned to you') });
    expect(await db.order.count()).toBe(1);
  });

  it('treats a lead that is still in the pool as not theirs either', async () => {
    await ingest([lead({ externalId: 'A1' })]);
    expect(await checkLeadDuplicate(as(alex), { phone: '0412 345 678' })).toEqual({ level: 'other' });
  });

  it('points a salesperson at their own open order', async () => {
    const first = await createLeadManually(as(sam), lead({ externalId: undefined }));
    expect(await checkLeadDuplicate(as(sam), { phone: '0412 345 678' })).toEqual({ level: 'own', orderId: first.orderId, orderNo: first.orderNo });
    await expect(createLeadManually(as(sam), lead({ externalId: undefined }))).rejects.toMatchObject({ orderId: first.orderId });
  });

  it('lets a salesperson add a new order for a past customer of theirs', async () => {
    const first = await createLeadManually(as(sam), lead({ externalId: undefined }));
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await markLost(as(sam), { orderId: first.orderId, reasonId: reason.id });
    expect(await checkLeadDuplicate(as(sam), { phone: '0412 345 678' })).toEqual({ level: 'returning', customerName: 'Jane Smith' });
    const second = await createLeadManually(as(sam), lead({ externalId: undefined }));
    expect(second.status).toBe('created');
    expect(second.orderId).not.toBe(first.orderId);
    expect(await db.customer.count()).toBe(1);
  });

  it('shows managers the full picture and lets them choose the owner', async () => {
    const first = await createLeadManually(as(sam), lead({ externalId: undefined }));
    const hint = await checkLeadDuplicate(as(manager), { phone: '0412 345 678' });
    expect(hint).toMatchObject({ level: 'match', customerName: 'Jane Smith', orders: [{ id: first.orderId, ownerName: 'Sam Sales', open: true }] });

    const other = await createLeadManually(as(manager), lead({ externalId: undefined, firstName: 'Omar', phone: '0477 000 111', email: 'omar@example.com', address: '4 Far St' }), { ownerId: alex.id });
    expect((await db.order.findUniqueOrThrow({ where: { id: other.orderId } })).ownerId).toBe(alex.id);
    await expect(createLeadManually(as(manager), lead({ externalId: undefined, phone: '0477 000 222', email: 'q@example.com' }), { ownerId: manager.id })).rejects.toBeInstanceOf(ValidationError);
  });

  it('maps validation problems to fields', async () => {
    await expect(createLeadManually(as(sam), lead({ externalId: undefined, phone: '123' }))).rejects.toMatchObject({
      fieldErrors: { phone: 'Please enter a valid phone number.' },
    });
  });
});

describe('CSV import', () => {
  const csv = [
    'First Name,Last Name,Mobile,Email,Street Address,Suburb,State,Postcode,Interested In,Monthly Bill,Favourite colour',
    'Ann,Lee,0411 222 333,ann@example.com,"Unit 2, 8 Hill Rd",Ryde,NSW,2112,Solar; Battery,280,blue',
    'Bob,Ng,0411 222 444,,9 Dale St,Epping,NSW,2121,Solar,,red',
    'Cy,Roe,12,cy@example.com,,,,,,,',
  ].join('\n');

  it('maps loosely named columns and ignores unknown ones', () => {
    const parsed = parseLeadCsv(csv);
    expect(parsed.ignoredColumns).toEqual(['Favourite colour']);
    expect(parsed.leads[0]).toEqual({
      firstName: 'Ann',
      lastName: 'Lee',
      phone: '0411 222 333',
      email: 'ann@example.com',
      address: 'Unit 2, 8 Hill Rd',
      suburb: 'Ryde',
      state: 'NSW',
      postcode: '2112',
      components: ['Solar', 'Battery'],
      monthlyBill: '280',
    });
    expect(() => parseLeadCsv('Email\nx@example.com')).toThrow(/firstName/);
  });

  it('previews without writing, then imports', async () => {
    const csvSource = await source('csv-import');
    const preview = await importLeadCsv(as(manager), csv, { sourceId: csvSource.id, dryRun: true, backfill: false });
    expect(preview).toMatchObject({ received: 3, created: 2, failed: 1 });
    expect(preview.results[2]!.error).toBe('phone: Please enter a valid phone number.');
    expect(await db.order.count()).toBe(0);

    const done = await importLeadCsv(as(manager), csv, { sourceId: csvSource.id, dryRun: false, backfill: false });
    expect(done).toMatchObject({ created: 2, failed: 1 });
    expect(await db.order.count()).toBe(2);
    // Importing the same file again creates nothing new: the rows join the open orders.
    const again = await importLeadCsv(as(manager), csv, { sourceId: csvSource.id, dryRun: false, backfill: false });
    expect(again).toMatchObject({ created: 0, duplicates: 2, failed: 1 });
    expect(await db.order.count()).toBe(2);
  });

  it('reads files the way spreadsheets write them', () => {
    const parsed = parseLeadCsv(
      [
        'Name,Phone,Postcode,State,Date',
        'Dana Van Der Berg,0411 000 111,800,NT,12/03/2025',
        'Cher,0411 000 222,2000,NSW,2025-03-12 14:30',
        'Eve Adams,0411 000 333,2000,NSW,3/7/2025 2:05 pm',
        'Finn Oak,0411 000 444,2000,NSW,2025-03-12T09:00:00+11:00',
        'Gus Hill,0411 000 555,2000,NSW,next Tuesday',
      ].join('\n'),
    );
    // One "name" column is split; a Northern Territory postcode gets its zero back.
    expect(parsed.leads[0]).toMatchObject({ firstName: 'Dana Van Der', lastName: 'Berg', postcode: '0800' });
    expect(parsed.leads[1]).toMatchObject({ firstName: 'Cher' });
    expect(parsed.leads[1]).not.toHaveProperty('lastName');
    expect(parsed.leads[0]).not.toHaveProperty('fullName');
    // Dates are day-first and business-local; a bare date is midday so it stays on its day.
    expect(parsed.leads[0]!.createdAt).toBe('2025-03-12T01:00:00.000Z'); // 12 March, noon in Sydney (UTC+11)
    expect(parsed.leads[1]!.createdAt).toBe('2025-03-12T03:30:00.000Z');
    expect(parsed.leads[2]!.createdAt).toBe('2025-07-03T04:05:00.000Z'); // 3 July, 2:05 pm (UTC+10)
    expect(parsed.leads[3]!.createdAt).toBe('2025-03-12T09:00:00+11:00');
    // What cannot be read is left for the normal validation to report on that row.
    expect(parsed.leads[4]!.createdAt).toBe('next Tuesday');
  });

  it('is for managers only', async () => {
    const csvSource = await source('csv-import');
    await expect(importLeadCsv(as(sam), csv, { sourceId: csvSource.id, dryRun: true, backfill: false })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
