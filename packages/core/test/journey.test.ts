import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptHandoff,
  archiveContract,
  assignOrders,
  createQuote,
  createTask,
  decideDeposit,
  getHandoffChecklist,
  ingestLeads,
  logActivity,
  markQuoteSent,
  parseDateOnly,
  pushOrder,
  requireOrderView,
  returnHandoff,
  submitDeposit,
  systemCtx,
  updateProperty,
  uploadDocument,
  type HandoffSnapshot,
} from '../src';
import { Clock, as, docType, lead, makeUser, pdf, png, resetDb, source, staged, stream, testDb, type TestUser } from './helpers';

const db = testDb();
let manager: TestUser, sam: TestUser, alex: TestUser, fin: TestUser, ops: TestUser;
let orderId: string;
let clock: Clock;

const stageOf = async () => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).stage;

beforeEach(async () => {
  await resetDb();
  clock = new Clock();
  manager = await makeUser(['MANAGER'], 'Morgan Manager');
  sam = await makeUser(['SALES'], 'Sam Sales');
  alex = await makeUser(['SALES'], 'Alex Sales');
  fin = await makeUser(['FINANCE'], 'Fay Finance');
  ops = await makeUser(['OPS'], 'Olly Ops');
  const res = await ingestLeads(systemCtx(db, 'Bluven website', clock.now), [lead()], { sourceId: (await source('bluven-website')).id, requireExternalId: true });
  orderId = res.results[0]!.id!;
});

describe('the sales journey from lead to handover', () => {
  it('walks every stage, with the right people seeing and doing the right things', async () => {
    // ---- pool: only managers can see it
    expect(await stageOf()).toBe('NEW');
    await expect(requireOrderView(db, as(sam), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(requireOrderView(db, as(ops), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(requireOrderView(db, as(fin), orderId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await requireOrderView(db, as(manager), orderId)).view).toBe('FULL');

    // ---- assignment
    await expect(assignOrders(as(sam), { orderIds: [orderId], ownerId: sam.id })).rejects.toMatchObject({ code: 'forbidden' });
    await assignOrders(as(manager, clock), { orderIds: [orderId], ownerId: sam.id });
    expect((await requireOrderView(db, as(sam), orderId)).view).toBe('FULL');
    await expect(requireOrderView(db, as(alex), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(logActivity(as(alex, clock), { orderId, type: 'NOTE', body: 'sneaky' })).rejects.toMatchObject({ code: 'not_found' });

    // ---- a note is not contact; a call is
    clock.advanceMinutes(30);
    await logActivity(as(sam, clock), { orderId, type: 'NOTE', body: 'Will call after lunch.' });
    expect(await stageOf()).toBe('NEW');
    clock.advanceMinutes(90);
    await logActivity(as(sam, clock), { orderId, type: 'CALL', body: 'Discussed a 6.6 kW system with battery.', outcome: 'connected' });
    expect(await stageOf()).toBe('CONTACTED');
    const afterCall = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(afterCall.firstContactedAt!.getTime() - afterCall.assignedAt!.getTime()).toBe(120 * 60_000);
    await createTask(as(sam, clock), { orderId, title: 'Send quote', dueAt: new Date(clock.current.getTime() + 86_400_000) });

    // ---- quote: recording a version changes nothing, sending it does
    const quote = await createQuote(as(sam, clock), {
      orderId,
      title: '6.6 kW + 13.5 kWh',
      dcWatts: 6600,
      storageWh: 13500,
      totalCents: 1_850_000,
      depositCents: 185_000,
      notes: '',
      file: await staged(pdf('quote v1'), 'Quote Jane Smith.pdf'),
    });
    expect(quote.version).toBe(1);
    expect(await stageOf()).toBe('CONTACTED');
    await markQuoteSent(as(sam, clock), { quoteId: quote.id });
    expect(await stageOf()).toBe('QUOTED');

    // ---- deposit before contract is refused
    await expect(
      submitDeposit(as(sam, clock), { orderId, amountCents: 185_000, method: 'BANK_TRANSFER', files: [await staged(await png(1), 'transfer.png')] }),
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('signed contract') });

    // ---- contract
    await archiveContract(as(sam, clock), { orderId, quoteId: quote.id, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('signed'), 'signed.pdf')] });
    expect(await stageOf()).toBe('SIGNED');
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).isAccepted).toBe(true);

    // ---- deposit: sales submits, finance decides
    const deposit = await submitDeposit(as(sam, clock), { orderId, amountCents: 185_000, method: 'BANK_TRANSFER', files: [await staged(await png(2), 'transfer.png')] });
    expect(await stageOf()).toBe('DEPOSIT_PENDING');
    expect((await requireOrderView(db, as(fin), orderId)).view).toBe('FINANCE');
    expect(await db.notification.count({ where: { userId: fin.id, type: 'deposit.submitted' } })).toBe(1);
    await expect(decideDeposit(as(sam, clock), { depositId: deposit.id, decision: 'CONFIRM', receivedAmountCents: 185_000, receivedOn: parseDateOnly('2026-11-10') })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(decideDeposit(as(manager, clock), { depositId: deposit.id, decision: 'CONFIRM', receivedAmountCents: 185_000, receivedOn: parseDateOnly('2026-11-10') })).rejects.toMatchObject({ code: 'forbidden' });

    // ---- pushing before finance confirms is refused, and says what is missing
    await expect(pushOrder(as(sam, clock), { orderId })).rejects.toMatchObject({
      code: 'validation',
      message: 'Not ready to push yet. Still missing: Deposit confirmed by finance, Electricity bill, Installation location photos, Meter box / switchboard photos.',
    });

    await decideDeposit(as(fin, clock), { depositId: deposit.id, decision: 'CONFIRM', receivedAmountCents: 185_000, receivedOn: parseDateOnly('2026-11-10'), bankReference: 'NAB 123456' });
    expect(await stageOf()).toBe('DEPOSIT_CONFIRMED');
    expect(await db.notification.count({ where: { userId: sam.id, type: 'deposit.confirmed' } })).toBe(1);

    // ---- documents
    let checklist = await getHandoffChecklist(db, orderId);
    expect(checklist.items.map((i) => [i.key, i.ok])).toEqual([
      ['address', true],
      ['contract', true],
      ['deposit', true],
      ['doc:electricity_bill', false],
      ['doc:install_location', false],
      ['doc:meter_box', false],
    ]);
    for (const [key, name, n] of [['electricity_bill', 'bill.pdf', 0], ['install_location', 'garage-wall.png', 3], ['meter_box', 'meter-box.png', 4]] as const) {
      const body = name.endsWith('.pdf') ? pdf(key) : await png(n);
      await uploadDocument(as(sam, clock), { orderId, typeId: (await docType(key)).id, fileName: name, body: stream(body) });
    }
    checklist = await getHandoffChecklist(db, orderId);
    expect(checklist.complete).toBe(true);

    // ---- operations sees nothing until the push
    await expect(requireOrderView(db, as(ops), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(pushOrder(as(alex, clock), { orderId })).rejects.toMatchObject({ code: 'not_found' });
    const pushed = await pushOrder(as(sam, clock), { orderId, notes: 'Customer prefers mornings. Dog in the yard.' });
    expect(pushed.version).toBe(1);
    expect(await stageOf()).toBe('PUSHED');
    expect((await requireOrderView(db, as(ops), orderId)).view).toBe('OPS');
    expect(await db.notification.count({ where: { userId: ops.id, type: 'handoff.pushed' } })).toBe(1);

    const pkg = await db.handoffPackage.findFirstOrThrow({ where: { orderId } });
    const snap = pkg.snapshot as unknown as HandoffSnapshot;
    expect(snap.customer).toMatchObject({ name: 'Jane Smith', phones: ['0412 345 678'], emails: ['jane@example.com'] });
    expect(snap.property.address).toBe('12 Sample St, Parramatta NSW 2150');
    expect(snap.quote).toMatchObject({ version: 1, dcWatts: 6600, storageWh: 13500, totalCents: 1_850_000 });
    expect(snap.deposit).toMatchObject({ receivedAmountCents: 185_000, receivedOn: '2026-11-10', bankReference: 'NAB 123456', confirmedBy: 'Fay Finance' });
    expect(snap.contract).toMatchObject({ signedOn: '2026-11-09' });
    expect(snap.documents.map((d) => d.typeKey).sort()).toEqual(['deposit_proof', 'electricity_bill', 'install_location', 'meter_box', 'quote', 'signed_contract']);
    expect(snap.order.notes).toBe('Customer prefers mornings. Dog in the yard.');

    // ---- while operations has it, sales cannot change it
    await expect(uploadDocument(as(sam, clock), { orderId, typeId: (await docType('other')).id, fileName: 'late.pdf', body: stream(pdf('late')) })).rejects.toMatchObject({ code: 'conflict' });
    await expect(pushOrder(as(sam, clock), { orderId })).rejects.toMatchObject({ code: 'conflict' });
    await logActivity(as(sam, clock), { orderId, type: 'NOTE', body: 'Notes are still fine.' });

    // ---- only operations decides
    await expect(acceptHandoff(as(sam, clock), { orderId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(returnHandoff(as(ops, clock), { orderId, reason: '  ' })).rejects.toMatchObject({ code: 'validation' });

    // ---- return loop
    clock.advanceDays(1);
    await returnHandoff(as(ops, clock), { orderId, reason: 'Meter box photo is blurry, please retake with the door open.', missing: ['doc:meter_box', 'not-a-real-key'] });
    expect(await stageOf()).toBe('RETURNED');
    const returned = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(returned.returnCount).toBe(1);
    expect((await db.handoffPackage.findFirstOrThrow({ where: { orderId, version: 1 } })).returnMissing).toEqual(['doc:meter_box']);
    const fixTask = await db.task.findFirstOrThrow({ where: { orderId, kind: 'RETURNED' } });
    expect(fixTask).toMatchObject({ assigneeId: sam.id, status: 'OPEN', notes: 'Meter box photo is blurry, please retake with the door open.' });
    expect(await db.notification.count({ where: { type: 'handoff.returned', userId: { in: [sam.id, manager.id] } } })).toBe(2);
    await expect(acceptHandoff(as(ops, clock), { orderId })).rejects.toMatchObject({ code: 'conflict' });

    // ---- sales fixes it and pushes again; the deposit does not need confirming twice
    await uploadDocument(as(sam, clock), { orderId, typeId: (await docType('meter_box')).id, fileName: 'meter-box-clear.png', body: stream(await png(9)) });
    const again = await pushOrder(as(sam, clock), { orderId });
    expect(again.version).toBe(2);
    expect(await stageOf()).toBe('PUSHED');
    // The task that asked for this closes itself instead of sitting in the list, overdue.
    expect(await db.task.findUniqueOrThrow({ where: { id: fixTask.id } })).toMatchObject({ status: 'DONE', completedById: sam.id });

    await acceptHandoff(as(ops, clock), { orderId });
    expect(await stageOf()).toBe('HANDED_OVER');
    const done = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(done.handedOverAt).not.toBeNull();
    expect(done.returnCount).toBe(1);
    expect(await db.notification.count({ where: { type: 'handoff.accepted', userId: { in: [sam.id, manager.id] } } })).toBe(2);

    // ---- the sales side is closed: read-only, but notes remain possible
    await expect(updateProperty(as(sam, clock), { orderId, addressLine1: '1 Other St', addressLine2: '', suburb: 'X', state: 'NSW', postcode: '2000', propertyType: '', nmi: '', retailer: '', phase: '', roofType: '', storeys: '', notes: '' })).rejects.toMatchObject({ code: 'conflict' });
    await logActivity(as(sam, clock), { orderId, type: 'CALL', body: 'Customer asked about the install date; referred to ops.', outcome: 'connected', direction: 'inbound' });

    // ---- the timeline tells the story in order
    const stages = (await db.activity.findMany({ where: { orderId, type: 'STAGE_CHANGE' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((a) => a.summary.replace('Stage changed from ', ''));
    expect(stages).toEqual([
      'New to Contacted',
      'Contacted to Quoted',
      'Quoted to Signed',
      'Signed to Deposit pending',
      'Deposit pending to Deposit confirmed',
      'Deposit confirmed to Pushed to Ops',
      'Pushed to Ops to Returned by Ops',
      'Returned by Ops to Pushed to Ops',
      'Pushed to Ops to Handed over',
    ]);

    // ---- and every step left an audit record with its actor
    const actions = (await db.auditLog.findMany({ where: { orderId }, orderBy: { at: 'asc' } })).map((a) => a.action);
    for (const expected of ['order.create', 'order.assign', 'activity.log', 'task.create', 'quote.create', 'quote.sent', 'contract.archive', 'deposit.submit', 'deposit.confirm', 'document.upload', 'handoff.push', 'handoff.return', 'handoff.accept', 'order.stage']) {
      expect(actions).toContain(expected);
    }
    const confirm = await db.auditLog.findFirstOrThrow({ where: { orderId, action: 'deposit.confirm' } });
    expect(confirm).toMatchObject({ actorId: fin.id, actorLabel: 'Fay Finance', ip: '203.0.113.7' });
    expect(confirm.after).toMatchObject({ status: 'CONFIRMED', receivedAmountCents: 185_000, bankReference: 'NAB 123456' });
  });

  it('refuses to push with an incomplete address even when everything else is there', async () => {
    await assignOrders(as(manager, clock), { orderIds: [orderId], ownerId: sam.id });
    await updateProperty(as(sam, clock), { orderId, addressLine1: '12 Sample St', addressLine2: '', suburb: '', state: 'NSW', postcode: '2150', propertyType: 'House', nmi: '', retailer: '', phase: '', roofType: '', storeys: '', notes: '' });
    const checklist = await getHandoffChecklist(db, orderId);
    expect(checklist.items[0]).toMatchObject({ key: 'address', ok: false });
    await expect(pushOrder(as(sam, clock), { orderId })).rejects.toMatchObject({ message: expect.stringContaining('Installation address') });
  });

  it('lets a manager do what the owning salesperson can', async () => {
    await assignOrders(as(manager, clock), { orderIds: [orderId], ownerId: sam.id });
    await logActivity(as(manager, clock), { orderId, type: 'MESSAGE', body: 'Texted the customer while Sam was out.' });
    expect(await stageOf()).toBe('CONTACTED');
  });

  it('validates what is logged', async () => {
    await assignOrders(as(manager, clock), { orderIds: [orderId], ownerId: sam.id });
    await expect(logActivity(as(sam, clock), { orderId, type: 'CALL', body: 'x' })).rejects.toMatchObject({ fieldErrors: { outcome: expect.any(String) } });
    await expect(logActivity(as(sam, clock), { orderId, type: 'NOTE', body: '   ' })).rejects.toMatchObject({ fieldErrors: { body: expect.any(String) } });
    await expect(logActivity(as(sam, clock), { orderId, type: 'EMAIL_IN', body: 'x' })).rejects.toMatchObject({ fieldErrors: { type: expect.any(String) } });
    await expect(logActivity(as(sam, clock), { orderId, type: 'NOTE', body: 'x', occurredAt: new Date(clock.current.getTime() + 3_600_000) })).rejects.toMatchObject({ fieldErrors: { occurredAt: expect.any(String) } });
  });
});
