'use server';

import { acceptHandoff, returnHandoff } from '@bluven/core';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { list, str } from '@/lib/form';

export async function acceptHandoffAction(orderId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await acceptHandoff(ctx, { orderId });
  });
}

export async function returnHandoffAction(orderId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await returnHandoff(ctx, { orderId, reason: str(formData, 'reason'), missing: list(formData, 'missing') });
  });
}
