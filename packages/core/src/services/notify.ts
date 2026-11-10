import type { DbOrTx, Role } from '@bluven/db';
import { actorId, nowOf, type Ctx } from '../context';
import { newId } from '../ids';

export interface NotificationInput {
  /** Machine-readable kind, e.g. "order.assigned", "deposit.rejected". */
  type: string;
  title: string;
  body?: string;
  /** In-app path the notification links to. */
  href?: string;
  orderId?: string | null;
}

/**
 * Creates one in-app notification per recipient. The acting user is never notified about their
 * own action. Rows start with emailStatus PENDING; the worker sends or skips the email.
 */
export async function notifyUsers(db: DbOrTx, ctx: Ctx, userIds: Iterable<string | null | undefined>, n: NotificationInput): Promise<number> {
  const self = actorId(ctx);
  const recipients = [...new Set([...userIds].filter((id): id is string => !!id && id !== self))];
  if (recipients.length === 0) return 0;
  const now = nowOf(ctx);
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      id: newId('ntf'),
      userId,
      type: n.type,
      title: n.title.slice(0, 200),
      body: (n.body ?? '').slice(0, 2000),
      href: n.href ?? '',
      orderId: n.orderId ?? null,
      emailStatus: 'PENDING' as const,
      createdAt: now,
    })),
  });
  return recipients.length;
}

/** Ids of active users holding any of the given roles. */
export async function userIdsWithRoles(db: DbOrTx, roles: Role[]): Promise<string[]> {
  const users = await db.user.findMany({
    where: { isActive: true, roles: { hasSome: roles } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/** Managers are the fallback audience for anything nobody owns. Admins who are not managers are not paged. */
export function managerIds(db: DbOrTx): Promise<string[]> {
  return userIdsWithRoles(db, ['MANAGER']);
}

export async function notifyRoles(db: DbOrTx, ctx: Ctx, roles: Role[], n: NotificationInput): Promise<number> {
  return notifyUsers(db, ctx, await userIdsWithRoles(db, roles), n);
}
