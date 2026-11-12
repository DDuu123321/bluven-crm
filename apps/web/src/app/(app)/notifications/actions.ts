'use server';

import { markNotificationsRead, setDailySummary } from '@bluven/core';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { bool } from '@/lib/form';

export async function markAllReadAction() {
  return runAction(async (ctx) => {
    await markNotificationsRead(ctx, 'all');
  });
}

export async function dailySummaryAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const on = bool(formData, 'dailySummary');
    await setDailySummary(ctx, on);
    return { message: on ? 'Saved. Your first summary comes tomorrow morning.' : 'Saved. You get an e-mail for each notification again.' };
  });
}
