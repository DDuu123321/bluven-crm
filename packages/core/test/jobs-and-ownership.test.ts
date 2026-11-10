import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignOrders,
  createTask,
  decideDeposit,
  logActivity,
  parseDateOnly,
  requireOrderView,
  returnOrdersToPool,
  runIdleRules,
  runTaskReminders,
  setTaskStatus,
  systemCtx,
  transferOrders,
  updateSettings,
  updateTask,
} from '../src';
import { as, makeUser, resetDb, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;
const order = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const idle = () => runIdleRules(systemCtx(db, 'System', w.clock.now));
const count = (userId: string, type: string) => db.notification.count({ where: { userId, type } });

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('idle rules', () => {
  it('reminds the salesperson at 5 days, managers at 10, and returns the order to the pool at 15', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await createTask(as(w.sam, w.clock), { orderId, title: 'Call back', dueAt: new Date('2026-12-30T00:00:00Z') });

    w.clock.advanceDays(4.9);
    expect(await idle()).toEqual({ ownerReminders: 0, managerReminders: 0, returnedToPool: 0 });

    w.clock.advanceDays(0.2); // 5.1 days
    expect(await idle()).toEqual({ ownerReminders: 1, managerReminders: 0, returnedToPool: 0 });
    expect(await count(w.sam.id, 'order.idle_owner')).toBe(1);
    expect((await order(orderId)).idleLevel).toBe(1);
    // Running again the same day does not nag twice.
    expect(await idle()).toEqual({ ownerReminders: 0, managerReminders: 0, returnedToPool: 0 });

    w.clock.advanceDays(5); // 10.1 days
    expect(await idle()).toEqual({ ownerReminders: 0, managerReminders: 1, returnedToPool: 0 });
    expect(await count(w.manager.id, 'order.idle_manager')).toBe(1);
    expect(await count(w.sam.id, 'order.idle_owner')).toBe(1);

    w.clock.advanceDays(5); // 15.1 days
    expect(await idle()).toEqual({ ownerReminders: 0, managerReminders: 0, returnedToPool: 1 });
    const o = await order(orderId);
    expect(o).toMatchObject({ ownerId: null, idleLevel: 0, stage: 'NEW' });
    await expect(requireOrderView(db, as(w.sam), orderId)).rejects.toMatchObject({ code: 'not_found' });
    expect(await count(w.sam.id, 'order.unassigned')).toBe(1);
    expect(await count(w.manager.id, 'order.idle_returned')).toBe(1);
    // The open task waits in the pool with nobody assigned.
    expect((await db.task.findFirstOrThrow({ where: { orderId } })).assigneeId).toBeNull();
    const activity = await db.activity.findFirstOrThrow({ where: { orderId, type: 'ASSIGNMENT' }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] });
    expect(activity.summary).toBe('Returned to the unassigned pool automatically after 15 days without activity (was with Sam Sales)');
    expect(activity.actorLabel).toBe('System');

    // The next owner inherits the task.
    await assignOrders(as(w.manager, w.clock), { orderIds: [orderId], ownerId: w.alex.id });
    expect((await db.task.findFirstOrThrow({ where: { orderId } })).assigneeId).toBe(w.alex.id);
  });

  it('restarts the clock on staff activity only', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    w.clock.advanceDays(4);
    await logActivity(as(w.sam, w.clock), { orderId, type: 'NOTE', body: 'Left a voicemail.' });
    w.clock.advanceDays(4); // 8 days after assignment, 4 after the note
    expect(await idle()).toEqual({ ownerReminders: 0, managerReminders: 0, returnedToPool: 0 });
    w.clock.advanceDays(1.1); // 5.1 after the note
    expect((await idle()).ownerReminders).toBe(1);
    // A reminder is not activity: the manager reminder still comes at 10 days from the note.
    w.clock.advanceDays(5);
    expect((await idle()).managerReminders).toBe(1);
    // Acting on it clears the reminders.
    await logActivity(as(w.sam, w.clock), { orderId, type: 'CALL', body: 'Reached them.', outcome: 'connected' });
    expect((await order(orderId)).idleLevel).toBe(0);
  });

  it('tells managers too when the first check finds an order already past ten days', async () => {
    await orderAt(w, 'ASSIGNED');
    w.clock.advanceDays(11);
    expect(await idle()).toEqual({ ownerReminders: 1, managerReminders: 1, returnedToPool: 0 });
  });

  it('never takes a signed order away', async () => {
    const { orderId } = await orderAt(w, 'SIGNED');
    w.clock.advanceDays(30);
    expect(await idle()).toEqual({ ownerReminders: 1, managerReminders: 1, returnedToPool: 0 });
    expect((await order(orderId)).ownerId).toBe(w.sam.id);
    w.clock.advanceDays(30);
    expect(await idle()).toEqual({ ownerReminders: 0, managerReminders: 0, returnedToPool: 0 });
  });

  it('does not count time spent waiting for finance', async () => {
    const { orderId, depositId } = await orderAt(w, 'DEPOSIT_PENDING');
    w.clock.advanceDays(20);
    expect(await idle()).toEqual({ ownerReminders: 0, managerReminders: 0, returnedToPool: 0 });
    // Finance rejects: the clock starts for sales from that moment.
    await decideDeposit(as(w.fin, w.clock), { depositId: depositId!, decision: 'REJECT', note: 'Not received.' });
    expect(await idle()).toEqual({ ownerReminders: 0, managerReminders: 0, returnedToPool: 0 });
    w.clock.advanceDays(5.1);
    expect((await idle()).ownerReminders).toBe(1);
    expect((await order(orderId)).ownerId).toBe(w.sam.id);
  });

  it('follows the thresholds an admin sets', async () => {
    const admin = await makeUser(['ADMIN']);
    await updateSettings(as(admin), { idle: { remindOwnerDays: 2, remindManagerDays: 3, returnToPoolDays: 4 }, defaultDepositPercent: 10 });
    await expect(updateSettings(as(w.manager), { idle: { remindOwnerDays: 1, remindManagerDays: 2, returnToPoolDays: 3 }, defaultDepositPercent: 10 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateSettings(as(admin), { idle: { remindOwnerDays: 5, remindManagerDays: 5, returnToPoolDays: 4 }, defaultDepositPercent: 10 })).rejects.toMatchObject({
      fieldErrors: { remindManagerDays: expect.any(String), returnToPoolDays: expect.any(String) },
    });
    const { orderId } = await orderAt(w, 'ASSIGNED');
    w.clock.advanceDays(2.1);
    expect((await idle()).ownerReminders).toBe(1);
    w.clock.advanceDays(2);
    expect((await idle()).returnedToPool).toBe(1);
    expect((await order(orderId)).ownerId).toBeNull();
  });
});

describe('ownership', () => {
  it('reassigns with notifications to both people and a timeline entry', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await db.notification.deleteMany();
    await assignOrders(as(w.manager, w.clock), { orderIds: [orderId], ownerId: w.alex.id });
    expect(await count(w.alex.id, 'order.assigned')).toBe(1);
    expect(await count(w.sam.id, 'order.unassigned')).toBe(1);
    const a = await db.activity.findFirstOrThrow({ where: { orderId, type: 'ASSIGNMENT' }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] });
    expect(a.summary).toBe('Reassigned from Sam Sales to Alex Sales');
    // Assigning to the same person again is a no-op.
    expect(await assignOrders(as(w.manager, w.clock), { orderIds: [orderId], ownerId: w.alex.id })).toEqual({ changed: 0 });
  });

  it('only assigns to active salespeople', async () => {
    const { orderId } = await orderAt(w, 'NEW');
    await expect(assignOrders(as(w.manager), { orderIds: [orderId], ownerId: w.fin.id })).rejects.toMatchObject({ code: 'validation' });
    await db.user.update({ where: { id: w.alex.id }, data: { isActive: false } });
    await expect(assignOrders(as(w.manager), { orderIds: [orderId], ownerId: w.alex.id })).rejects.toMatchObject({ code: 'validation' });
  });

  it('transfers everything a person owns, or only their open orders', async () => {
    const a = await orderAt(w, 'ASSIGNED');
    const b = await orderAt(w, 'QUOTED', { phone: '0400 000 002', email: 'b@example.com', address: '2 B St' });
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    const { markLost } = await import('../src');
    await markLost(as(w.sam, w.clock), { orderId: b.orderId, reasonId: reason.id });

    expect(await transferOrders(as(w.manager, w.clock), { fromUserId: w.sam.id, toUserId: w.alex.id, onlyOpen: true })).toEqual({ changed: 1 });
    expect((await order(a.orderId)).ownerId).toBe(w.alex.id);
    expect((await order(b.orderId)).ownerId).toBe(w.sam.id);
    expect(await transferOrders(as(w.manager, w.clock), { fromUserId: w.sam.id, toUserId: w.alex.id })).toEqual({ changed: 1 });
    expect((await order(b.orderId)).ownerId).toBe(w.alex.id);
    await expect(transferOrders(as(w.sam), { fromUserId: w.sam.id, toUserId: w.alex.id })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets a manager put orders back in the pool', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await returnOrdersToPool(as(w.manager, w.clock), { orderIds: [orderId], note: 'Sam is on leave.' });
    expect((await order(orderId)).ownerId).toBeNull();
  });
});

describe('tasks', () => {
  it('reminds the assignee once when a task comes due', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const due = new Date(w.clock.current.getTime() + 2 * 86_400_000);
    const task = await createTask(as(w.sam, w.clock), { orderId, title: 'Send the quote', dueAt: due });
    const run = () => runTaskReminders(systemCtx(db, 'System', w.clock.now));
    expect(await run()).toEqual({ reminded: 0 });
    w.clock.advanceDays(2.01);
    expect(await run()).toEqual({ reminded: 1 });
    expect(await run()).toEqual({ reminded: 0 });
    expect(await count(w.sam.id, 'task.due')).toBe(1);

    // Moving the due date arms the reminder again.
    await updateTask(as(w.sam, w.clock), { taskId: task.id, title: 'Send the quote', dueAt: new Date(w.clock.current.getTime() + 86_400_000), notes: '' });
    w.clock.advanceDays(1.01);
    expect(await run()).toEqual({ reminded: 1 });

    await setTaskStatus(as(w.sam, w.clock), { taskId: task.id, status: 'DONE' });
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'DONE', completedById: w.sam.id });
    await expect(setTaskStatus(as(w.alex, w.clock), { taskId: task.id, status: 'OPEN' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('needs a title and a due date', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await expect(createTask(as(w.sam, w.clock), { orderId, title: ' ', dueAt: null })).rejects.toMatchObject({ fieldErrors: { title: expect.any(String), dueAt: expect.any(String) } });
    void parseDateOnly;
  });
});
