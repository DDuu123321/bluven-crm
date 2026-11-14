// Operations after acceptance: the reminders that follow a finished job, the e-mails that go to
// the customer by themselves, the lists operations and finance work from, and who keeps the
// list of lead sources.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OPERATIONS_SETTINGS,
  acceptHandoff,
  addOpsNote,
  confirmFinalPayment,
  createLeadOrigin,
  finalPaymentsDueCount,
  getOperationsSettings,
  getOperationsView,
  listFinalPayments,
  listNotices,
  listOpsJobs,
  markJobDone,
  openJob,
  opsJobCounts,
  parseDateOnly,
  retryNotice,
  returnHandoff,
  runOperationsReminders,
  sendScheduleNotice,
  setRebateApplied,
  systemCtx,
  updateLeadOrigin,
  updateOperationsSettings,
  updateOpsJob,
  type OperationsSettings,
  type OpsJobInput,
} from '../src';
import { as, leadOrigin, makeUser, resetDb, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;
const remind = () => runOperationsReminders(systemCtx(db, 'System', w.clock.now));
const count = (userId: string, type: string) => db.notification.count({ where: { userId, type } });
const at = (iso: string) => {
  w.clock.current = new Date(iso);
};
const second = { phone: '0400 555 666', email: 'second@example.com', address: '2 Other Rd' };
const booked = (orderId: string): OpsJobInput => ({ orderId, caStatus: 'APPROVED', caReference: '', stcPlatform: 'formbay', stcReference: '', installerName: 'Joe Volt', electricianLicence: 'EC 1', installDate: parseDateOnly('2026-12-12'), deliveryMode: 'PICKUP', deliveryEta: null, purchaseStatus: 'IN_STOCK' });

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('after a job is done', () => {
  it('reminds operations to apply for the rebate after two working days, and that the balance is open after five, each once', async () => {
    const { orderId } = await orderAt(w, 'ACCEPTED');
    // Thursday 19 November 2026, 10 am in Sydney.
    at('2026-11-18T23:00:00Z');
    await markJobDone(as(w.ops, w.clock), { orderId });

    // Friday is one working day, and the weekend adds none.
    at('2026-11-21T23:00:00Z'); // Sunday
    expect(await remind()).toEqual({ rebateReminders: 0, balanceReminders: 0 });
    // Monday is the second.
    at('2026-11-22T23:00:00Z');
    expect(await remind()).toEqual({ rebateReminders: 1, balanceReminders: 0 });
    expect(await count(w.ops.id, 'ops.rebate_due')).toBe(1);
    expect(await remind()).toEqual({ rebateReminders: 0, balanceReminders: 0 });

    // The customer was given five working days: Thursday 26 November.
    const view = (await getOperationsView(as(w.ops, w.clock), orderId))!;
    expect(view.balance.dueOn).toEqual(parseDateOnly('2026-11-26'));
    expect(view.balance.overdue).toBe(false);
    expect(view.rebate).toMatchObject({ dueOn: parseDateOnly('2026-11-23'), overdue: true });
    at('2026-11-24T23:00:00Z'); // Wednesday
    expect(await remind()).toEqual({ rebateReminders: 0, balanceReminders: 0 });
    at('2026-11-25T23:00:00Z'); // Thursday
    expect(await remind()).toEqual({ rebateReminders: 0, balanceReminders: 1 });
    const note = await db.notification.findFirstOrThrow({ where: { userId: w.ops.id, type: 'ops.balance_due' } });
    expect(note.body).toContain('within 5 working days');
    expect(note.href).toBe(`/ops/orders/${orderId}`);
    expect((await getOperationsView(as(w.ops, w.clock), orderId))!.balance.overdue).toBe(true);
    // The salesperson is not told by the clock: they do not see the account. Operations asks them.
    expect(await db.notification.count({ where: { userId: w.sam.id, type: { startsWith: 'ops.balance' } } })).toBe(0);
    at('2026-12-20T23:00:00Z');
    expect(await remind()).toEqual({ rebateReminders: 0, balanceReminders: 0 });
  });

  it('says nothing about what is already done', async () => {
    const a = await orderAt(w, 'ACCEPTED');
    const b = await orderAt(w, 'ACCEPTED', second);
    at('2026-11-18T23:00:00Z');
    const ops = as(w.ops, w.clock);
    await markJobDone(ops, { orderId: a.orderId });
    await markJobDone(ops, { orderId: b.orderId });
    // The rebate of the first is applied for the same day; the balance of the second comes in the next.
    await setRebateApplied(ops, { orderId: a.orderId, applied: true });
    at('2026-11-19T23:00:00Z');
    await confirmFinalPayment(as(w.ops, w.clock), { orderId: b.orderId });
    at('2026-12-05T23:00:00Z');
    // One balance reminder (the first job), one rebate reminder (the second, closed as it is: the rebate is still owed).
    expect(await remind()).toEqual({ rebateReminders: 1, balanceReminders: 1 });
    expect((await db.opsJob.findUniqueOrThrow({ where: { orderId: a.orderId } })).rebateRemindedAt).toBeNull();
    expect((await db.opsJob.findUniqueOrThrow({ where: { orderId: b.orderId } })).rebateRemindedAt).not.toBeNull();
    // Taking the tick back does not bring an old reminder back.
    await setRebateApplied(as(w.ops, w.clock), { orderId: b.orderId, applied: true });
    await setRebateApplied(as(w.ops, w.clock), { orderId: b.orderId, applied: false });
    expect(await remind()).toEqual({ rebateReminders: 0, balanceReminders: 0 });
  });

  it('follows the number of days an admin sets, in the reminders and in the e-mail', async () => {
    const admin = await makeUser(['ADMIN']);
    const settings = await getOperationsSettings(db);
    expect(settings).toEqual(DEFAULT_OPERATIONS_SETTINGS);
    await expect(updateOperationsSettings(as(w.manager), settings)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateOperationsSettings(as(admin), { ...settings, balanceDays: 0, rebateReminderDays: 1.5 })).rejects.toMatchObject({ fieldErrors: { balanceDays: expect.any(String), rebateReminderDays: expect.any(String) } });
    await updateOperationsSettings(as(admin), { ...settings, balanceDays: 3, rebateReminderDays: 1 });

    const { orderId } = await orderAt(w, 'ACCEPTED');
    at('2026-11-18T23:00:00Z'); // Thursday
    await markJobDone(as(w.ops, w.clock), { orderId });
    expect((await listNotices(db, orderId))[0]!.body).toContain('within 3 working days');
    at('2026-11-19T23:00:00Z'); // Friday
    expect(await remind()).toEqual({ rebateReminders: 1, balanceReminders: 0 });
    at('2026-11-23T23:00:00Z'); // Tuesday: the third working day
    expect(await remind()).toEqual({ rebateReminders: 0, balanceReminders: 1 });
  });
});

describe('the e-mails to the customer', () => {
  const text = (over: Partial<OperationsSettings['notices']['WELCOME']> = {}) => ({ ...DEFAULT_OPERATIONS_SETTINGS.notices.WELCOME, ...over });

  it('are written from texts an admin keeps, with fields that are checked when the text is saved', async () => {
    const admin = await makeUser(['ADMIN']);
    const base = await getOperationsSettings(db);
    const withWelcome = (welcome: OperationsSettings['notices']['WELCOME']): OperationsSettings => ({ ...base, notices: { ...base.notices, WELCOME: welcome } });
    await expect(updateOperationsSettings(as(admin), withWelcome(text({ subject: ' ', body: '' })))).rejects.toMatchObject({ fieldErrors: { 'WELCOME.subject': expect.any(String), 'WELCOME.body': expect.any(String) } });
    // A field nobody fills in would reach the customer in its braces.
    await expect(updateOperationsSettings(as(admin), withWelcome(text({ body: 'Hi {{firstname}}' })))).rejects.toMatchObject({ fieldErrors: { 'WELCOME.body': expect.stringContaining('{{firstname}}') } });
    await expect(updateOperationsSettings(as(admin), withWelcome(text({ subject: 'Hello {{constructor}}' })))).rejects.toMatchObject({ fieldErrors: { 'WELCOME.subject': expect.any(String) } });
    await updateOperationsSettings(as(admin), withWelcome(text({ subject: 'Welcome, {{first_name}}', body: 'Hi {{full_name}},\r\n\r\nYour order {{order_no}} at {{address}} is with us. {{salesperson}} says hello.' })));

    const { orderId } = await orderAt(w, 'ACCEPTED');
    const [welcome] = await listNotices(db, orderId);
    expect(welcome).toMatchObject({ kind: 'WELCOME', status: 'PENDING', toAddress: 'jane@example.com', subject: 'Welcome, Jane' });
    expect(welcome!.body).toBe('Hi Jane Smith,\n\nYour order BLV-2026-00001 at 12 Sample St, Parramatta NSW 2150 is with us. Sam Sales says hello.');
    expect(await db.auditLog.count({ where: { action: 'settings.update', entityId: 'operations' } })).toBe(1);
  });

  it('do not go out when they are switched off', async () => {
    const admin = await makeUser(['ADMIN']);
    const base = await getOperationsSettings(db);
    await updateOperationsSettings(as(admin), { ...base, notices: { ...base.notices, WELCOME: text({ enabled: false }), SCHEDULE: { ...base.notices.SCHEDULE, enabled: false } } });
    const { orderId } = await orderAt(w, 'ACCEPTED');
    expect(await listNotices(db, orderId)).toEqual([]);
    await updateOpsJob(as(w.ops, w.clock), booked(orderId));
    await expect(sendScheduleNotice(as(w.ops, w.clock), { orderId })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('switched off') });
    // The thank-you is still on.
    await markJobDone(as(w.ops, w.clock), { orderId });
    expect((await listNotices(db, orderId)).map((n) => n.kind)).toEqual(['JOB_DONE']);
  });

  it('go once per order: a job that came back and was accepted again is not welcomed twice', async () => {
    const { orderId } = await orderAt(w, 'ACCEPTED');
    const ops = as(w.ops, w.clock);
    // Accepted, and then it turns out that only the salesperson can sort something out.
    await returnHandoff(ops, { orderId, reason: 'The customer wants to change the system and will only talk to Sam.' });
    expect(await db.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: 'RETURNED', returnCount: 1 });
    // What operations had arranged is not lost while the order is with sales.
    const { pushOrder } = await import('../src');
    await pushOrder(as(w.sam, w.clock), { orderId });
    await acceptHandoff(ops, { orderId, depositReceived: true });
    expect(await db.opsJob.count({ where: { orderId } })).toBe(1);
    expect((await listNotices(db, orderId)).map((n) => n.kind)).toEqual(['WELCOME']);
    // The deposit was confirmed the first time and stays that way.
    expect(await db.auditLog.count({ where: { orderId, action: 'deposit.confirm' } })).toBe(1);
    expect(await db.notification.count({ where: { userId: w.fin.id, type: 'deposit.received' } })).toBe(1);
  });

  it('are held back, with the reason, for a customer who has no address to write to', async () => {
    const { orderId } = await orderAt(w, 'PUSHED');
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    await db.customerEmail.deleteMany({ where: { customerId: order.customerId } });
    await acceptHandoff(as(w.ops, w.clock), { orderId, depositReceived: true });
    const [welcome] = await listNotices(db, orderId);
    expect(welcome).toMatchObject({ status: 'SKIPPED', toAddress: '', note: expect.stringContaining('no e-mail address on record') });
    await expect(retryNotice(as(w.ops, w.clock), { noticeId: welcome!.id })).rejects.toMatchObject({ code: 'conflict' });
    // Once there is one, the same e-mail can go out after all.
    await db.customerEmail.create({ data: { id: 'cem_test', customerId: order.customerId, email: 'jane.new@example.com', isPrimary: true } });
    await retryNotice(as(w.ops, w.clock), { noticeId: welcome!.id });
    expect((await listNotices(db, orderId))[0]).toMatchObject({ status: 'PENDING', toAddress: 'jane.new@example.com' });
    await expect(retryNotice(as(w.ops, w.clock), { noticeId: welcome!.id })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('already waiting') });
  });
});

describe('the lists operations and finance work from', () => {
  it('show each job in its stage, with what is still open and what is overdue', async () => {
    const arranging = await orderAt(w, 'ACCEPTED');
    const waiting = await orderAt(w, 'ACCEPTED', second);
    const ops = as(w.ops, w.clock);
    await updateOpsJob(ops, booked(waiting.orderId));
    await orderAt(w, 'PUSHED', { phone: '0400 555 777', email: 'third@example.com', address: '3 Other Rd' });

    let jobs = await listOpsJobs(ops, 'IN_PROGRESS');
    // The one with a date comes first; the one nobody has booked yet is at the end.
    expect(jobs.map((j) => j.orderId)).toEqual([waiting.orderId, arranging.orderId]);
    expect(jobs[0]).toMatchObject({ customerName: 'Jane Smith', salesperson: 'Sam Sales', itemsDone: 6, itemsTotal: 6, openItems: [], installDate: parseDateOnly('2026-12-12') });
    expect(jobs[1]).toMatchObject({ itemsDone: 0, openItems: ['Connection approval', 'Job assigned for the certificates', 'Installer', 'Installation date', 'Delivery', 'Stock'] });
    expect(await opsJobCounts(db)).toEqual({ inProgress: 2, installed: 0 });
    await expect(listOpsJobs(as(w.sam, w.clock), 'IN_PROGRESS')).rejects.toMatchObject({ code: 'forbidden' });

    at('2026-11-18T23:00:00Z');
    await markJobDone(as(w.ops, w.clock), { orderId: waiting.orderId });
    at('2026-11-30T23:00:00Z');
    jobs = await listOpsJobs(as(w.ops, w.clock), 'INSTALLED');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ orderId: waiting.orderId, rebateApplied: false, rebateOverdue: true, balanceDueOn: parseDateOnly('2026-11-26'), balanceOverdue: true, chaseAskedAt: null });
    expect(await opsJobCounts(db)).toEqual({ inProgress: 1, installed: 1 });

    // Finance sees what should still come in: the total of the accepted proposal less the deposit.
    expect(await finalPaymentsDueCount(db)).toBe(1);
    const due = await listFinalPayments(as(w.fin, w.clock), 'DUE');
    expect(due).toEqual([expect.objectContaining({ orderId: waiting.orderId, totalCents: 900_000, depositCents: 90_000, balanceCents: 810_000, overdue: true, receivedCents: null })]);
    await expect(listFinalPayments(as(w.sam, w.clock), 'DUE')).rejects.toMatchObject({ code: 'forbidden' });

    await confirmFinalPayment(as(w.fin, w.clock), { orderId: waiting.orderId, amountCents: 810_000, receivedOn: parseDateOnly('2026-11-30') });
    expect(await listFinalPayments(as(w.fin, w.clock), 'DUE')).toEqual([]);
    expect(await listFinalPayments(as(w.ops, w.clock), 'RECEIVED')).toEqual([expect.objectContaining({ orderId: waiting.orderId, receivedCents: 810_000, receivedOn: parseDateOnly('2026-11-30'), overdue: false })]);
    expect((await listOpsJobs(as(w.ops, w.clock), 'COMPLETED')).map((j) => j.orderId)).toEqual([waiting.orderId]);
  });
});

describe('notes from operations', () => {
  it('are written by operations only and read by everyone on the order', async () => {
    const { orderId } = await orderAt(w, 'ACCEPTED');
    const ops = as(w.ops, w.clock);
    await addOpsNote(ops, { orderId, body: 'Roof is steeper than the photos show. Two installers booked.' });
    w.clock.advanceMinutes(1);
    await addOpsNote(ops, { orderId, body: 'Customer away 1 to 5 December.' });
    await expect(addOpsNote(ops, { orderId, body: '   ' })).rejects.toMatchObject({ code: 'validation' });
    await expect(addOpsNote(as(w.sam, w.clock), { orderId, body: 'From sales' })).rejects.toMatchObject({ code: 'forbidden' });

    // Newest first, for the salesperson as for operations. A note the salesperson logs is not among them.
    for (const reader of [w.sam, w.manager, w.ops]) {
      const view = await getOperationsView(as(reader, w.clock), orderId);
      expect(view?.notes.map((n) => [n.body, n.by])).toEqual([
        ['Customer away 1 to 5 December.', 'Olly Ops'],
        ['Roof is steeper than the photos show. Two installers booked.', 'Olly Ops'],
      ]);
    }
    // Another salesperson has no business with the order, and finance sees the money only.
    await expect(getOperationsView(as(w.alex, w.clock), orderId)).rejects.toMatchObject({ code: 'not_found' });
    expect(await getOperationsView(as(w.fin, w.clock), orderId)).toBeNull();
    // They are part of the order's history as well.
    expect(await db.activity.count({ where: { orderId, type: 'NOTE', summary: 'Note from operations' } })).toBe(2);
  });
});

describe('the list of lead sources', () => {
  it('is kept by managers, and a source that is retired stays on the orders that carry it', async () => {
    const manager = as(w.manager, w.clock);
    await expect(createLeadOrigin(as(w.sam, w.clock), { label: 'Northside Electrical' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createLeadOrigin(manager, { label: '  ' })).rejects.toMatchObject({ fieldErrors: { label: expect.any(String) } });
    await expect(createLeadOrigin(manager, { label: 'Partner' })).rejects.toMatchObject({ fieldErrors: { label: 'Already in use.' } });
    const created = await createLeadOrigin(manager, { label: 'Northside Electrical' });
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await openJob(as(w.sam, w.clock), { orderId, leadOriginId: created.id });

    await updateLeadOrigin(manager, { originId: created.id, label: 'Northside Electrical Pty Ltd', isActive: false, sortOrder: 5 });
    expect(await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { leadOrigin: true } })).toMatchObject({ leadOrigin: { label: 'Northside Electrical Pty Ltd', isActive: false } });
    // It is no longer a choice for the next job.
    const next = await orderAt(w, 'ASSIGNED', second);
    await expect(openJob(as(w.sam, w.clock), { orderId: next.orderId, leadOriginId: created.id })).rejects.toMatchObject({ fieldErrors: { leadOriginId: expect.any(String) } });
    // The last one in use cannot be retired, or no job could be opened.
    const all = await db.leadOrigin.findMany({ where: { isActive: true } });
    for (const o of all.slice(1)) await updateLeadOrigin(manager, { originId: o.id, label: o.label, isActive: false, sortOrder: o.sortOrder });
    const last = all[0]!;
    await expect(updateLeadOrigin(manager, { originId: last.id, label: last.label, isActive: false, sortOrder: last.sortOrder })).rejects.toMatchObject({ code: 'conflict' });
    await openJob(as(w.sam, w.clock), { orderId: next.orderId, leadOriginId: last.id });
    expect(await db.auditLog.count({ where: { action: { startsWith: 'lead_origin.' } } })).toBeGreaterThanOrEqual(3);
    expect((await leadOrigin(last.key)).isActive).toBe(true);
  });
});
