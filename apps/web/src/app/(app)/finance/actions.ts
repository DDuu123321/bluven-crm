'use server';

import { setRefundStatus } from '@bluven/core';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';

// Finance decides nothing about deposits: operations confirms one when it accepts the order,
// and finance is told. Saying that a final payment has arrived is shared with operations and
// lives with the operations actions.

export async function markRefundedAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await setRefundStatus(ctx, { orderId, refundStatus: 'REFUNDED' });
  });
}
