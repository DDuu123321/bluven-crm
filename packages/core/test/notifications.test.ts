import { beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, getDailySummary, listNotifications, notificationEmailRoute, notificationKind, notificationKindCounts, notifyUsers, setDailySummary, systemCtx, type NotificationKind } from '../src';
import { as, makeUser, resetDb, testDb, type TestUser } from './helpers';

const db = testDb();
let sam: TestUser;

// Every notification type the application sends, by the kind it is filed under.
const TYPES: Record<NotificationKind, string[]> = {
  leads: ['order.assigned', 'order.unassigned', 'order.possible_duplicate', 'order.restored', 'pool.new_leads', 'lead.duplicate', 'intake.pull_failing', 'intake.pull_rejected'],
  idle: ['order.idle_owner', 'order.idle_manager', 'order.idle_returned'],
  email: ['mail.received', 'mail.reconnect', 'mail.unplaced', 'mail.unreadable', 'mail.notice_failed'],
  deposits: ['deposit.received', 'deposit.gateway', 'payment.final', 'refund.pending', 'refund.updated', 'order.cancelled'],
  handoff: ['handoff.pushed', 'handoff.returned', 'handoff.accepted', 'handoff.withdrawn', 'ops.install_date', 'ops.job_done', 'ops.rebate_due', 'ops.balance_due', 'ops.balance_chase'],
  tasks: ['task.due', 'order.hold_ended'],
  documents: ['retention.reminder', 'retention.overdue', 'retention.auto_deleted', 'bill.address_differs'],
  pylon: ['pylon.signed', 'pylon.accepted', 'pylon.conflict', 'pylon.event_failed', 'pylon.unreachable', 'pylon.payment_not_applied', 'pylon.signed_not_applied', 'pylon.signed_other_version'],
  other: ['something.new', 'order.unheard_of'],
};

beforeEach(async () => {
  await resetDb();
  sam = await makeUser(['SALES'], 'Sam Sales');
});

describe('notification kinds', () => {
  it('file every type the application sends, and anything unknown under “other”', () => {
    for (const kind of NOTIFICATION_KINDS) for (const type of TYPES[kind]) expect([type, notificationKind(type)]).toEqual([type, kind]);
  });

  it('filter the list in the database exactly as they are filed', async () => {
    const ctx = systemCtx(db);
    for (const type of Object.values(TYPES).flat()) await notifyUsers(db, ctx, [sam.id], { type, title: type });
    for (const kind of NOTIFICATION_KINDS) {
      const listed = (await listNotifications(as(sam), { kind, take: 200 })).map((n) => n.type).sort();
      expect(listed).toEqual([...TYPES[kind]].sort());
    }
    expect(await listNotifications(as(sam), { take: 200 })).toHaveLength(Object.values(TYPES).flat().length);

    // Counts per kind, with the unread ones apart. Somebody else's notifications are not counted.
    const other = await makeUser(['SALES']);
    await notifyUsers(db, ctx, [other.id], { type: 'task.due', title: 'not mine' });
    await db.notification.updateMany({ where: { userId: sam.id, type: { startsWith: 'handoff.' } }, data: { readAt: new Date() } });
    await db.notification.updateMany({ where: { userId: sam.id, type: 'task.due' }, data: { readAt: new Date() } });
    const counts = await notificationKindCounts(as(sam));
    expect(counts.map((c) => c.kind)).toEqual([...NOTIFICATION_KINDS]);
    // Four read out of nine: the kind takes in what operations does after accepting an order as well.
    expect(counts.find((c) => c.kind === 'handoff')).toEqual({ kind: 'handoff', total: 9, unread: 5 });
    expect(counts.find((c) => c.kind === 'tasks')).toEqual({ kind: 'tasks', total: 2, unread: 1 });
    expect((await listNotifications(as(sam), { kind: 'tasks', unreadOnly: true })).map((n) => n.type)).toEqual(['order.hold_ended']);
    // A kind without notifications is not offered as a filter.
    expect((await notificationKindCounts(as(other))).map((c) => c.kind)).toEqual(['tasks']);
  });
});

describe('the daily summary preference', () => {
  it('is each person’s own choice, and switching it off does not release a day of e-mails at once', async () => {
    expect(await getDailySummary(as(sam))).toBe(false);
    await setDailySummary(as(sam), true);
    expect(await getDailySummary(as(sam))).toBe(true);
    await notifyUsers(db, systemCtx(db), [sam.id], { type: 'task.due', title: 'Waiting for the summary' });
    await notifyUsers(db, systemCtx(db), [sam.id], { type: 'mail.received', title: 'In the CRM only', inAppOnly: true });

    await setDailySummary(as(sam), false);
    const notes = await db.notification.findMany({ where: { userId: sam.id }, orderBy: { title: 'asc' } });
    expect(notes.map((n) => [n.title, n.emailStatus])).toEqual([
      ['In the CRM only', 'NONE'],
      ['Waiting for the summary', 'SKIPPED'],
    ]);
    const log = await db.auditLog.findMany({ where: { action: 'user.preference', entityId: sam.id }, orderBy: { at: 'asc' } });
    expect(log.map((l) => l.summary)).toEqual(['Sam Sales switched the daily summary e-mail on', 'Sam Sales switched the daily summary e-mail off']);
    // Saying the same thing twice changes nothing and logs nothing.
    await setDailySummary(as(sam), false);
    expect(await db.auditLog.count({ where: { action: 'user.preference' } })).toBe(2);
  });
});

describe('whether this server can send notification e-mail', () => {
  it('is one answer for the worker that sends and the page that offers the daily summary', () => {
    const off = { mailRelay: { url: '', key: '' }, smtpUrl: '' };
    expect(notificationEmailRoute(off)).toBeNull();
    expect(notificationEmailRoute({ ...off, smtpUrl: 'smtp://mail.example.com' })).toBe('smtp');
    // The relay needs both its address and its key; half a setting is no setting.
    expect(notificationEmailRoute({ ...off, mailRelay: { url: 'https://www.example.com/api/send-mail', key: '' } })).toBeNull();
    expect(notificationEmailRoute({ ...off, mailRelay: { url: 'https://www.example.com/api/send-mail', key: 'k' } })).toBe('relay');
    // With both, the relay wins: it is there for hosts that block SMTP.
    expect(notificationEmailRoute({ smtpUrl: 'smtp://mail.example.com', mailRelay: { url: 'https://www.example.com/api/send-mail', key: 'k' } })).toBe('relay');
  });
});
