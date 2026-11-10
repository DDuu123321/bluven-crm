'use server';

import { markNotificationsRead } from '@bluven/core';
import { runAction } from '@/lib/action';

export async function markAllReadAction() {
  return runAction(async (ctx) => {
    await markNotificationsRead(ctx, 'all');
  });
}
