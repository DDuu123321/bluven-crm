import 'server-only';
import { can, openTaskCount, pendingDepositCount, pendingHandoffCount, unassignedCount, unreadNotificationCount, type Ctx, type SessionUser } from '@bluven/core';

/** The numbers shown as badges in the sidebar, limited to what the user works with. */
export async function navCounts(ctx: Ctx, user: SessionUser): Promise<Record<string, number>> {
  const [notifications, tasks, unassigned, deposits, handoffs] = await Promise.all([
    unreadNotificationCount(ctx),
    can(user, 'orders.work') ? openTaskCount(ctx).then((t) => t.overdue) : 0,
    can(user, 'orders.assign') ? unassignedCount(ctx.db) : 0,
    can(user, 'finance.deposits') ? pendingDepositCount(ctx.db) : 0,
    can(user, 'ops.handoffs') ? pendingHandoffCount(ctx.db) : 0,
  ]);
  return { notifications, tasks, unassigned, deposits, handoffs };
}
