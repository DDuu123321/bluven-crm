// Background jobs run by the worker. Each is idempotent and safe to run as often as you like.
import { Prisma, type Db } from '@bluven/db';
import { inTx, nowOf, systemCtx, type Ctx } from '../context';
import { getConfig } from '../config';
import { evaluateIdle, idleDays, isIdleTrackedStage, ORDER_STAGES, todayDateOnly } from '../domain';
import { audit } from './audit';
import { setOrderOwner } from './assignment';
import { managerIds, notifyUsers } from './notify';
import { lockOrder, loadOrderState, orderHref } from './orders';
import { getSettings } from './settings';
import { resumeOrderInTx } from './sidestate';

/**
 * Runs `fn` unless another worker instance already holds the job's lock. Advisory locks are
 * released when the transaction that took them ends, so a crashed worker never blocks the job.
 */
async function withJobLock<T>(db: Db, lockKey: number, fn: () => Promise<T>): Promise<T | null> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>(Prisma.sql`SELECT pg_try_advisory_xact_lock(${lockKey}::bigint) AS locked`);
      if (!rows[0]?.locked) return null;
      return fn();
    },
    { maxWait: 5_000, timeout: 10 * 60_000 },
  );
}

export interface IdleRunResult {
  ownerReminders: number;
  managerReminders: number;
  returnedToPool: number;
}

/**
 * The 5 / 10 / 15 day rules: remind the salesperson, remind the managers, and take unsigned
 * orders back into the pool. Thresholds come from the settings.
 */
export async function runIdleRules(base: Ctx | Db): Promise<IdleRunResult> {
  const ctx: Ctx = 'actor' in base ? base : systemCtx(base);
  const result: IdleRunResult = { ownerReminders: 0, managerReminders: 0, returnedToPool: 0 };
  await withJobLock(ctx.db, 760101, async () => {
    const thresholds = (await getSettings(ctx.db)).idle;
    const now = nowOf(ctx);
    const cutoff = new Date(now.getTime() - thresholds.remindOwnerDays * 86_400_000);
    const candidates = await ctx.db.order.findMany({
      where: {
        ownerId: { not: null },
        sideState: 'NONE',
        stage: { in: ORDER_STAGES.filter(isIdleTrackedStage) },
        lastStaffActivityAt: { lte: cutoff },
      },
      select: { id: true },
      orderBy: { lastStaffActivityAt: 'asc' },
      take: 500,
    });

    for (const { id } of candidates) {
      await inTx(ctx.db, async (tx) => {
        await lockOrder(tx, id);
        const order = await tx.order.findUniqueOrThrow({
          where: { id },
          select: { id: true, orderNo: true, customerId: true, ownerId: true, stage: true, sideState: true, lastStaffActivityAt: true, idleLevel: true, owner: { select: { name: true } } },
        });
        const action = evaluateIdle(order, now, thresholds);
        if (action === 'NONE') return;
        const days = Math.floor(idleDays(order.lastStaffActivityAt, now));

        if (action === 'RETURN_TO_POOL') {
          await setOrderOwner(tx, ctx, id, null, { kind: 'idle', days });
          result.returnedToPool++;
          return;
        }
        if (order.idleLevel < 1) {
          await notifyUsers(tx, ctx, [order.ownerId], {
            type: 'order.idle_owner',
            title: `${order.orderNo} has had no activity for ${days} days`,
            body:
              action === 'REMIND_OWNER'
                ? `Your manager will be told at ${thresholds.remindManagerDays} days.`
                : 'Your manager has been told as well.',
            href: orderHref(id),
            orderId: id,
          });
          result.ownerReminders++;
        }
        if (action === 'REMIND_MANAGER') {
          await notifyUsers(tx, ctx, await managerIds(tx), {
            type: 'order.idle_manager',
            title: `${order.orderNo} has been idle for ${days} days (${order.owner?.name ?? 'unassigned'})`,
            href: orderHref(id),
            orderId: id,
          });
          result.managerReminders++;
        }
        const level = action === 'REMIND_MANAGER' ? 2 : 1;
        await tx.order.update({ where: { id }, data: { idleLevel: level } });
        await audit(tx, ctx, {
          action: 'order.idle_reminder',
          entityType: 'Order',
          entityId: id,
          orderId: id,
          customerId: order.customerId,
          summary: `${order.orderNo}: idle for ${days} days, reminded ${level === 2 ? 'managers' : 'the salesperson'}`,
          meta: { days, level, thresholds },
        });
      });
    }
    return true;
  });
  return result;
}

/** Takes orders off hold on their follow-up date, with a task and a reminder for the salesperson. */
export async function runHoldExpiry(base: Ctx | Db): Promise<{ resumed: number }> {
  const ctx: Ctx = 'actor' in base ? base : systemCtx(base);
  let resumed = 0;
  await withJobLock(ctx.db, 760102, async () => {
    const today = todayDateOnly(nowOf(ctx), getConfig().timeZone);
    const due = await ctx.db.order.findMany({ where: { sideState: 'ON_HOLD', onHoldUntil: { lte: today } }, select: { id: true }, take: 500 });
    for (const { id } of due) {
      await inTx(ctx.db, async (tx) => {
        await lockOrder(tx, id);
        const order = await loadOrderState(tx, id);
        if (!order || order.sideState !== 'ON_HOLD') return;
        await resumeOrderInTx(tx, ctx, order, true);
        resumed++;
      });
    }
    return true;
  });
  return { resumed };
}

/** Reminds assignees of tasks that have come due. Each task is reminded once per due date. */
export async function runTaskReminders(base: Ctx | Db): Promise<{ reminded: number }> {
  const ctx: Ctx = 'actor' in base ? base : systemCtx(base);
  let reminded = 0;
  await withJobLock(ctx.db, 760103, async () => {
    const now = nowOf(ctx);
    const due = await ctx.db.task.findMany({
      where: { status: 'OPEN', remindedAt: null, dueAt: { lte: now }, assigneeId: { not: null } },
      include: { order: { select: { id: true, orderNo: true } } },
      orderBy: { dueAt: 'asc' },
      take: 500,
    });
    for (const task of due) {
      await inTx(ctx.db, async (tx) => {
        const claimed = await tx.task.updateMany({ where: { id: task.id, status: 'OPEN', remindedAt: null }, data: { remindedAt: now } });
        if (claimed.count === 0) return;
        await notifyUsers(tx, ctx, [task.assigneeId], {
          type: 'task.due',
          title: `Task due: ${task.title}`,
          body: task.order.orderNo,
          href: orderHref(task.order.id),
          orderId: task.order.id,
        });
        reminded++;
      });
    }
    return true;
  });
  return { reminded };
}
