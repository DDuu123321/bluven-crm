'use server';

import { decideDeposit, reopenDeposit, setRefundStatus } from '@bluven/core';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { dateOnly, money, str } from '@/lib/form';

export async function confirmDepositAction(depositId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await decideDeposit(ctx, {
      depositId,
      decision: 'CONFIRM',
      receivedAmountCents: money(formData, 'receivedAmount'),
      receivedOn: dateOnly(formData, 'receivedOn'),
      bankReference: str(formData, 'bankReference'),
      note: str(formData, 'note'),
    });
    return { redirectTo: '/finance' };
  });
}

export async function rejectDepositAction(depositId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await decideDeposit(ctx, { depositId, decision: 'REJECT', note: str(formData, 'note') });
    return { redirectTo: '/finance' };
  });
}

export async function reopenDepositAction(depositId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await reopenDeposit(ctx, { depositId, reason: str(formData, 'reason') });
  });
}

export async function markRefundedAction(orderId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await setRefundStatus(ctx, { orderId, refundStatus: 'REFUNDED' });
  });
}
