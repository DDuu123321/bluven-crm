import type { ActivityType, DbOrTx, Prisma } from '@bluven/db';
import { actorId, actorLabel, nowOf, type Ctx } from '../context';
import { newId } from '../ids';

export interface ActivityInput {
  customerId: string;
  orderId?: string | null;
  type: ActivityType;
  /** One line shown in the timeline. */
  summary: string;
  /** Longer free text, e.g. the note itself. */
  body?: string;
  payload?: unknown;
  /** When it happened. Defaults to now. */
  occurredAt?: Date;
}

/** Adds one entry to the customer timeline. */
export async function addActivity(db: DbOrTx, ctx: Ctx, a: ActivityInput): Promise<string> {
  const id = newId('act');
  const now = nowOf(ctx);
  await db.activity.create({
    data: {
      id,
      customerId: a.customerId,
      orderId: a.orderId ?? null,
      type: a.type,
      occurredAt: a.occurredAt ?? now,
      actorId: actorId(ctx),
      actorLabel: ctx.actor.kind === 'user' ? '' : actorLabel(ctx),
      summary: a.summary.slice(0, 500),
      body: a.body ?? '',
      payload: (a.payload === undefined ? {} : JSON.parse(JSON.stringify(a.payload))) as Prisma.InputJsonValue,
      createdAt: now,
    },
  });
  return id;
}
