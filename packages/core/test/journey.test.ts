import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptHandoff,
  addOpsNote,
  askSalesToChaseBalance,
  assignOrders,
  confirmCustomerEmail,
  confirmFinalPayment,
  createQuote,
  createTask,
  getHandoffChecklist,
  getOperationsView,
  ingestLeads,
  listNotices,
  logActivity,
  markJobDone,
  markQuoteSent,
  openJob,
  parseDateOnly,
  pushOrder,
  requireOrderView,
  retryNotice,
  returnHandoff,
  sendScheduleNotice,
  setIntent,
  setRebateApplied,
  submitDeposit,
  systemCtx,
  updateOpsJob,
  updateProperty,
  uploadDocument,
  type HandoffSnapshot,
  type OpsJobInput,
} from '../src';
import { Clock, as, docType, lead, leadOrigin, makeUser, pdf, png, resetDb, source, staged, stream, testDb, type TestUser } from './helpers';

const db = testDb();
let manager: TestUser, sam: TestUser, alex: TestUser, fin: TestUser, ops: TestUser;
let orderId: string;
let clock: Clock;

const stageOf = async () => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).stage;
const website = async () => (await leadOrigin('bluven_website')).id;

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

describe('the journey from a lead to a closed job', () => {
  it('walks every stage, with the right people seeing and doing the right things', async () => {
    // ---- pool: only managers can see it
    expect(await stageOf()).toBe('NEW');
    await expect(requireOrderView(db, as(sam), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(requireOrderView(db, as(ops), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(requireOrderView(db, as(fin), orderId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await requireOrderView(db, as(manager), orderId)).view).toBe('FULL');
    // Nobody opens a job that belongs to nobody.
    await expect(openJob(as(manager, clock), { orderId, leadOriginId: await website() })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Assign') });

    // ---- assignment
    await expect(assignOrders(as(sam), { orderIds: [orderId], ownerId: sam.id })).rejects.toMatchObject({ code: 'forbidden' });
    await assignOrders(as(manager, clock), { orderIds: [orderId], ownerId: sam.id });
    expect((await requireOrderView(db, as(sam), orderId)).view).toBe('FULL');
    await expect(requireOrderView(db, as(alex), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(logActivity(as(alex, clock), { orderId, type: 'NOTE', body: 'sneaky' })).rejects.toMatchObject({ code: 'not_found' });

    // ---- until the job is opened it is only a lead: nothing is worked on
    expect(await stageOf()).toBe('NEW');
    await expect(logActivity(as(sam, clock), { orderId, type: 'CALL', body: 'Rang.', outcome: 'connected' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Open the job') });
    await expect(uploadDocument(as(sam, clock), { orderId, typeId: (await docType('other')).id, fileName: 'early.pdf', body: stream(pdf('early')) })).rejects.toMatchObject({ code: 'conflict' });
    await expect(createQuote(as(sam, clock), { orderId, title: 'x', dcWatts: 1, storageWh: null, totalCents: 1, depositCents: null, notes: '' })).rejects.toMatchObject({ code: 'conflict' });

    // ---- opening the job: where the customer came from has to be said, and it is said once
    await expect(openJob(as(sam, clock), { orderId, leadOriginId: '' })).rejects.toMatchObject({ fieldErrors: { leadOriginId: expect.any(String) } });
    await expect(openJob(as(alex, clock), { orderId, leadOriginId: await website() })).rejects.toMatchObject({ code: 'not_found' });
    clock.advanceMinutes(30);
    await openJob(as(sam, clock), { orderId, leadOriginId: (await leadOrigin('partner')).id, note: 'Alpha Solar' });
    expect(await stageOf()).toBe('FOLLOW_UP');
    expect(await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { leadOrigin: true } })).toMatchObject({ openedById: sam.id, leadOrigin: { key: 'partner' }, leadOriginNote: 'Alpha Solar' });
    await expect(openJob(as(sam, clock), { orderId, leadOriginId: await website() })).rejects.toMatchObject({ code: 'conflict', message: 'This job is already open.' });

    // ---- following up: a note is not contact; a call is
    await logActivity(as(sam, clock), { orderId, type: 'NOTE', body: 'Will call after lunch.' });
    clock.advanceMinutes(90);
    await logActivity(as(sam, clock), { orderId, type: 'CALL', body: 'Discussed a 6.6 kW system with battery.', outcome: 'connected' });
    expect(await stageOf()).toBe('FOLLOW_UP');
    const afterCall = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(afterCall.firstContactedAt!.getTime() - afterCall.assignedAt!.getTime()).toBe(120 * 60_000);
    await createTask(as(sam, clock), { orderId, title: 'Send proposal', dueAt: new Date(clock.current.getTime() + 86_400_000) });

    // ---- the customer wants a proposal: design. It can be taken back for as long as nothing has gone out.
    await setIntent(as(sam, clock), { orderId, intent: 'DESIGN' });
    expect(await stageOf()).toBe('DESIGN');
    await setIntent(as(sam, clock), { orderId, intent: 'FOLLOW_UP' });
    expect(await stageOf()).toBe('FOLLOW_UP');
    await expect(setIntent(as(sam, clock), { orderId, intent: 'MAYBE' })).rejects.toMatchObject({ code: 'validation' });

    // ---- a quote version says by itself that the design has started; sending it is the proposal
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
    expect(await stageOf()).toBe('DESIGN');
    await markQuoteSent(as(sam, clock), { quoteId: quote.id });
    expect(await stageOf()).toBe('PROPOSAL_SENT');
    await expect(setIntent(as(sam, clock), { orderId, intent: 'FOLLOW_UP' })).rejects.toMatchObject({ code: 'conflict' });

    // ---- pushing without the deposit is refused, and says what is missing
    await expect(pushOrder(as(sam, clock), { orderId })).rejects.toMatchObject({
      code: 'validation',
      message: 'Not ready to push yet. Still missing: Proposal the customer accepted, Proof of the deposit, Electricity bill, Installation location photos, Meter box / switchboard photos.',
    });

    // ---- the deposit: sales files the proof, no contract is asked for, nobody has to confirm anything yet
    const deposit = await submitDeposit(as(sam, clock), { orderId, amountCents: 185_000, method: 'BANK_TRANSFER', files: [await staged(await png(2), 'transfer.png')] });
    expect(await stageOf()).toBe('DEPOSIT_PAID');
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).isAccepted).toBe(true);
    expect((await db.deposit.findUniqueOrThrow({ where: { id: deposit.id } })).status).toBe('PENDING');
    expect((await requireOrderView(db, as(fin), orderId)).view).toBe('FINANCE');
    // Finance hears about a deposit when it has arrived, not when sales says so.
    expect(await db.notification.count({ where: { userId: fin.id } })).toBe(0);

    // ---- the folder
    let checklist = await getHandoffChecklist(db, orderId);
    expect(checklist.items.map((i) => [i.key, i.ok])).toEqual([
      ['address', true],
      ['quote', true],
      ['deposit', true],
      ['doc:electricity_bill', false],
      ['doc:install_location', false],
      ['doc:meter_box', false],
    ]);
    for (const [key, name, n] of [['electricity_bill', 'bill.pdf', 0], ['install_location', 'garage-wall.png', 3], ['meter_box', 'meter-box.png', 4]] as const) {
      const file = name.endsWith('.pdf') ? pdf(key) : await png(n);
      await uploadDocument(as(sam, clock), { orderId, typeId: (await docType(key)).id, fileName: name, body: stream(file) });
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
    // As sales recorded it. Whether the money is there is for operations to say.
    expect(snap.deposit).toMatchObject({ amountCents: 185_000, method: 'BANK_TRANSFER', receivedAmountCents: null, confirmedBy: null });
    expect(snap.contract).toBeNull();
    expect(snap.documents.map((d) => d.typeKey).sort()).toEqual(['deposit_proof', 'electricity_bill', 'install_location', 'meter_box', 'quote']);
    expect(snap.order.notes).toBe('Customer prefers mornings. Dog in the yard.');

    // ---- while operations has it, sales cannot change it
    await expect(uploadDocument(as(sam, clock), { orderId, typeId: (await docType('other')).id, fileName: 'late.pdf', body: stream(pdf('late')) })).rejects.toMatchObject({ code: 'conflict' });
    await expect(pushOrder(as(sam, clock), { orderId })).rejects.toMatchObject({ code: 'conflict' });
    await logActivity(as(sam, clock), { orderId, type: 'NOTE', body: 'Notes are still fine.' });

    // ---- only operations decides, and accepting means the deposit has been seen in the account
    await expect(acceptHandoff(as(sam, clock), { orderId, depositReceived: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(acceptHandoff(as(ops, clock), { orderId, depositReceived: false })).rejects.toMatchObject({ fieldErrors: { depositReceived: expect.any(String) } });
    await expect(returnHandoff(as(ops, clock), { orderId, reason: '  ' })).rejects.toMatchObject({ code: 'validation' });
    // Nothing operations does later is possible before they accept.
    await expect(markJobDone(as(ops, clock), { orderId })).rejects.toMatchObject({ code: 'conflict', message: 'Accept the order first.' });

    // ---- the exception: back to sales, because only they can sort it out
    clock.advanceDays(1);
    await returnHandoff(as(ops, clock), { orderId, reason: 'The customer does not answer and the number may be wrong. Please get hold of them.', missing: ['doc:meter_box', 'not-a-real-key'] });
    expect(await stageOf()).toBe('RETURNED');
    const returned = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(returned.returnCount).toBe(1);
    expect((await db.handoffPackage.findFirstOrThrow({ where: { orderId, version: 1 } })).returnMissing).toEqual(['doc:meter_box']);
    const fixTask = await db.task.findFirstOrThrow({ where: { orderId, kind: 'RETURNED' } });
    expect(fixTask).toMatchObject({ assigneeId: sam.id, status: 'OPEN', notes: expect.stringContaining('does not answer') });
    expect(await db.notification.count({ where: { type: 'handoff.returned', userId: { in: [sam.id, manager.id] } } })).toBe(2);
    await expect(acceptHandoff(as(ops, clock), { orderId, depositReceived: true })).rejects.toMatchObject({ code: 'conflict' });

    // ---- sales sorts it out and pushes again
    await uploadDocument(as(sam, clock), { orderId, typeId: (await docType('meter_box')).id, fileName: 'meter-box-clear.png', body: stream(await png(9)) });
    const again = await pushOrder(as(sam, clock), { orderId });
    expect(again.version).toBe(2);
    expect(await stageOf()).toBe('PUSHED');
    // The task that asked for this closes itself instead of sitting in the list, overdue.
    expect(await db.task.findUniqueOrThrow({ where: { id: fixTask.id } })).toMatchObject({ status: 'DONE', completedById: sam.id });

    // ---- accepted: the deposit is confirmed, finance is told, the customer is welcomed
    // (An address that reached a customer's record with a later website enquiry is on it unconfirmed. This one is made so.)
    await db.customerEmail.updateMany({ where: { email: 'jane@example.com' }, data: { unconfirmed: true } });
    await acceptHandoff(as(ops, clock), { orderId, depositReceived: true });
    expect(await stageOf()).toBe('IN_PROGRESS');
    const accepted = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { opsJob: true } });
    expect(accepted.handedOverAt).not.toBeNull();
    expect(accepted.returnCount).toBe(1);
    expect(accepted.opsJob).toMatchObject({ caStatus: 'TODO', purchaseStatus: 'UNDECIDED', installDate: null });
    expect(await db.deposit.findUniqueOrThrow({ where: { id: deposit.id } })).toMatchObject({ status: 'CONFIRMED', decidedById: ops.id, receivedAmountCents: 185_000 });
    expect(await db.notification.count({ where: { type: 'handoff.accepted', userId: { in: [sam.id, manager.id] } } })).toBe(2);
    expect(await db.notification.findFirstOrThrow({ where: { userId: fin.id } })).toMatchObject({ type: 'deposit.received', title: expect.stringContaining('$1,850.00') });

    // Nobody has said that the address is the customer's: the welcome is written, and held back with the reason.
    let notices = await listNotices(db, orderId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'WELCOME', status: 'SKIPPED', subject: expect.stringMatching(/^Welcome to Bluven: your order BLV-/), note: expect.stringContaining('jane@example.com') });
    expect(notices[0]!.body).toContain('Hi Jane,');
    expect(notices[0]!.body).toContain('12 Sample St, Parramatta NSW 2150');
    // Operations may confirm it on an order of theirs, and send the e-mail after all.
    const address = await db.customerEmail.findFirstOrThrow({ where: { email: 'jane@example.com' } });
    await expect(confirmCustomerEmail(as(fin, clock), { orderId, emailId: address.id })).rejects.toMatchObject({ code: 'forbidden' });
    await confirmCustomerEmail(as(ops, clock), { orderId, emailId: address.id });
    await expect(retryNotice(as(sam, clock), { noticeId: notices[0]!.id })).rejects.toMatchObject({ code: 'forbidden' });
    await retryNotice(as(ops, clock), { noticeId: notices[0]!.id });
    expect((await listNotices(db, orderId))[0]).toMatchObject({ status: 'PENDING', toAddress: 'jane@example.com', note: '' });

    // ---- the sales side is closed: read-only, but notes remain possible
    await expect(updateProperty(as(sam, clock), { orderId, addressLine1: '1 Other St', addressLine2: '', suburb: 'X', state: 'NSW', postcode: '2000', propertyType: '', nmi: '', retailer: '', phase: '', roofType: '', storeys: '', notes: '' })).rejects.toMatchObject({ code: 'conflict' });
    await logActivity(as(sam, clock), { orderId, type: 'CALL', body: 'Customer asked about the install date; referred to ops.', outcome: 'connected', direction: 'inbound' });

    // ---- operations arranges the job, in whatever order things fall into place
    const job: OpsJobInput = { orderId, caStatus: 'APPLIED', caReference: 'AUSGRID-7781', stcPlatform: '', stcReference: '', installerName: '', electricianLicence: '', installDate: null, deliveryMode: '', deliveryEta: null, purchaseStatus: 'TO_ORDER' };
    await expect(updateOpsJob(as(sam, clock), job)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateOpsJob(as(manager, clock), job)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateOpsJob(as(ops, clock), { ...job, caStatus: 'MAYBE' })).rejects.toMatchObject({ fieldErrors: { caStatus: expect.any(String) } });
    await updateOpsJob(as(ops, clock), job);
    // Sales and managers read all of it and change none of it; finance has no part in it.
    const view = (await getOperationsView(as(sam, clock), orderId))!;
    expect(view.items.map((i) => [i.key, i.done])).toEqual([['ca', false], ['stc', false], ['installer', false], ['installDate', false], ['delivery', false], ['purchase', false]]);
    expect(view.items[0]!.detail).toBe('Applied for (AUSGRID-7781)');
    expect(await getOperationsView(as(fin, clock), orderId)).toBeNull();

    // The dates e-mail says the day and how the equipment arrives, so it waits for both.
    await expect(sendScheduleNotice(as(ops, clock), { orderId })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('installation date and the delivery') });
    const booked: OpsJobInput = { ...job, caStatus: 'APPROVED', stcPlatform: 'greendeal', installerName: 'Joe Volt', electricianLicence: 'EC 12345', installDate: parseDateOnly('2026-12-12'), deliveryMode: 'DELIVERY', deliveryEta: parseDateOnly('2026-12-10'), purchaseStatus: 'ORDERED' };
    await updateOpsJob(as(ops, clock), booked);
    expect((await getOperationsView(as(ops, clock), orderId))!.items.every((i) => i.done)).toBe(true);
    // The salesperson hears about the date: the customer will ask them.
    expect(await db.notification.findFirstOrThrow({ where: { userId: sam.id, type: 'ops.install_date' } })).toMatchObject({ title: expect.stringContaining('booked for 12 Dec 2026') });
    // Saving the same again changes nothing and says nothing.
    const entries = await db.activity.count({ where: { orderId } });
    await updateOpsJob(as(ops, clock), booked);
    expect(await db.activity.count({ where: { orderId } })).toBe(entries);

    expect(await sendScheduleNotice(as(ops, clock), { orderId })).toBe('queued');
    notices = await listNotices(db, orderId);
    expect(notices[0]).toMatchObject({ kind: 'SCHEDULE', status: 'PENDING', subject: 'Your Bluven installation is booked for 12 Dec 2026', payload: { installDate: '2026-12-12', deliveryMode: 'DELIVERY', deliveryEta: '2026-12-10' } });
    expect(notices[0]!.body).toContain('Your equipment is expected to arrive on 10 Dec 2026.');
    expect(notices[0]!.body).toContain('The work will be carried out by Joe Volt.');
    expect((await getOperationsView(as(ops, clock), orderId))!.scheduleUpToDate).toBe(true);
    await expect(sendScheduleNotice(as(ops, clock), { orderId })).rejects.toMatchObject({ code: 'conflict', message: 'The dates e-mail is already waiting to be sent.' });
    // A date that moves makes the e-mail out of date, for operations to send again.
    await updateOpsJob(as(ops, clock), { ...booked, installDate: parseDateOnly('2026-12-15') });
    expect((await getOperationsView(as(ops, clock), orderId))!.scheduleUpToDate).toBe(false);
    await addOpsNote(as(ops, clock), { orderId, body: 'Installer asked for the side gate to be unlocked.' });
    await expect(addOpsNote(as(sam, clock), { orderId, body: 'x' })).rejects.toMatchObject({ code: 'forbidden' });

    // ---- job done: the customer is thanked and asked for the balance
    await expect(confirmFinalPayment(as(ops, clock), { orderId })).rejects.toMatchObject({ code: 'conflict' });
    await expect(markJobDone(as(sam, clock), { orderId })).rejects.toMatchObject({ code: 'forbidden' });
    clock.advanceDays(30);
    await markJobDone(as(ops, clock), { orderId });
    expect(await stageOf()).toBe('INSTALLED');
    notices = await listNotices(db, orderId);
    expect(notices[0]).toMatchObject({ kind: 'JOB_DONE', status: 'PENDING', subject: 'Your Bluven installation is complete' });
    expect(notices[0]!.body).toContain('within 5 working days');
    expect(await db.notification.count({ where: { type: 'ops.job_done', userId: { in: [sam.id, manager.id] } } })).toBe(2);
    await expect(markJobDone(as(ops, clock), { orderId })).rejects.toMatchObject({ code: 'conflict', message: 'The job is already marked as done.' });
    // An installed job does not go back to sales.
    await expect(returnHandoff(as(ops, clock), { orderId, reason: 'too late' })).rejects.toMatchObject({ code: 'conflict' });

    // ---- the rebate, and the balance that has not come in
    await setRebateApplied(as(ops, clock), { orderId, applied: true });
    expect((await getOperationsView(as(ops, clock), orderId))!.rebate.appliedAt).not.toBeNull();
    await expect(askSalesToChaseBalance(as(sam, clock), { orderId })).rejects.toMatchObject({ code: 'forbidden' });
    await askSalesToChaseBalance(as(ops, clock), { orderId, note: 'Nothing in the account as of this morning.' });
    const chase = await db.task.findFirstOrThrow({ where: { orderId, kind: 'BALANCE' } });
    expect(chase).toMatchObject({ assigneeId: sam.id, status: 'OPEN', title: 'Ask the customer for the balance' });
    expect(await db.notification.count({ where: { userId: sam.id, type: 'ops.balance_chase' } })).toBe(1);
    await expect(askSalesToChaseBalance(as(ops, clock), { orderId })).rejects.toMatchObject({ code: 'conflict' });

    // ---- the final payment: operations or finance says that it is in, and the job is closed
    await expect(confirmFinalPayment(as(sam, clock), { orderId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(confirmFinalPayment(as(fin, clock), { orderId, amountCents: 1_665_000, receivedOn: parseDateOnly('2027-06-01') })).rejects.toMatchObject({ fieldErrors: { receivedOn: expect.any(String) } });
    await confirmFinalPayment(as(fin, clock), { orderId, amountCents: 1_665_000, note: 'NAB 998877' });
    expect(await stageOf()).toBe('COMPLETED');
    const closed = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { opsJob: true } });
    expect(closed).toMatchObject({ completedById: fin.id, opsJob: { finalAmountCents: 1_665_000, finalNote: 'NAB 998877' } });
    expect(await db.task.findUniqueOrThrow({ where: { id: chase.id } })).toMatchObject({ status: 'DONE' });
    expect(await db.notification.count({ where: { type: 'payment.final', userId: { in: [sam.id, manager.id] } } })).toBe(2);
    // Finance did it, so finance is not told about it.
    expect(await db.notification.count({ where: { type: 'payment.final', userId: fin.id } })).toBe(0);
    await expect(confirmFinalPayment(as(ops, clock), { orderId })).rejects.toMatchObject({ code: 'conflict', message: 'This job is closed.' });
    await expect(updateOpsJob(as(ops, clock), booked)).rejects.toMatchObject({ code: 'conflict' });

    // ---- the timeline tells the story in order
    const stages = (await db.activity.findMany({ where: { orderId, type: 'STAGE_CHANGE' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((a) => a.summary.replace('Stage changed from ', ''));
    expect(stages).toEqual([
      'New to Following up',
      'Following up to Design',
      'Design to Following up',
      'Following up to Design',
      'Design to Proposal sent',
      'Proposal sent to Deposit paid',
      'Deposit paid to Pushed to Ops',
      'Pushed to Ops to Returned by Ops',
      'Returned by Ops to Pushed to Ops',
      'Pushed to Ops to With operations',
      'With operations to Installed, balance due',
      'Installed, balance due to Completed',
    ]);

    // ---- and every step left an audit record with its actor
    const actions = (await db.auditLog.findMany({ where: { orderId }, orderBy: { at: 'asc' } })).map((a) => a.action);
    for (const expected of ['order.create', 'order.assign', 'order.open', 'order.intent', 'activity.log', 'task.create', 'quote.create', 'quote.sent', 'quote.accept', 'deposit.submit', 'document.upload', 'handoff.push', 'handoff.return', 'handoff.accept', 'deposit.confirm', 'ops.update', 'notice.queue', 'ops.job_done', 'ops.rebate', 'ops.balance_chase', 'ops.final_payment', 'order.stage']) {
      expect(actions, expected).toContain(expected);
    }
    const confirm = await db.auditLog.findFirstOrThrow({ where: { orderId, action: 'deposit.confirm' } });
    expect(confirm).toMatchObject({ actorId: ops.id, actorLabel: 'Olly Ops', ip: '203.0.113.7' });
    expect(confirm.after).toMatchObject({ status: 'CONFIRMED', receivedAmountCents: 185_000 });
  });

  it('refuses to push with an incomplete address even when everything else is there', async () => {
    await assignOrders(as(manager, clock), { orderIds: [orderId], ownerId: sam.id });
    await openJob(as(sam, clock), { orderId, leadOriginId: await website() });
    await updateProperty(as(sam, clock), { orderId, addressLine1: '12 Sample St', addressLine2: '', suburb: '', state: 'NSW', postcode: '2150', propertyType: 'House', nmi: '', retailer: '', phase: '', roofType: '', storeys: '', notes: '' });
    const checklist = await getHandoffChecklist(db, orderId);
    expect(checklist.items[0]).toMatchObject({ key: 'address', ok: false });
    await expect(pushOrder(as(sam, clock), { orderId })).rejects.toMatchObject({ message: expect.stringContaining('Installation address') });
  });

  it('lets a manager do what the owning salesperson can, opening the job included', async () => {
    await assignOrders(as(manager, clock), { orderIds: [orderId], ownerId: sam.id });
    await openJob(as(manager, clock), { orderId, leadOriginId: await website() });
    await logActivity(as(manager, clock), { orderId, type: 'MESSAGE', body: 'Texted the customer while Sam was out.' });
    expect(await stageOf()).toBe('FOLLOW_UP');
    // Opened on Sam's behalf: the job is his, and the record says who clicked.
    expect(await db.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ ownerId: sam.id, openedById: manager.id });
  });

  it('validates what is logged', async () => {
    await assignOrders(as(manager, clock), { orderIds: [orderId], ownerId: sam.id });
    await openJob(as(sam, clock), { orderId, leadOriginId: await website() });
    await expect(logActivity(as(sam, clock), { orderId, type: 'CALL', body: 'x' })).rejects.toMatchObject({ fieldErrors: { outcome: expect.any(String) } });
    await expect(logActivity(as(sam, clock), { orderId, type: 'NOTE', body: '   ' })).rejects.toMatchObject({ fieldErrors: { body: expect.any(String) } });
    await expect(logActivity(as(sam, clock), { orderId, type: 'EMAIL_IN', body: 'x' })).rejects.toMatchObject({ fieldErrors: { type: expect.any(String) } });
    await expect(logActivity(as(sam, clock), { orderId, type: 'NOTE', body: 'x', occurredAt: new Date(clock.current.getTime() + 3_600_000) })).rejects.toMatchObject({ fieldErrors: { occurredAt: expect.any(String) } });
  });
});
