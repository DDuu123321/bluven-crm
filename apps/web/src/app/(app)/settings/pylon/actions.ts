'use server';

import { retryPylonEvent } from '@bluven/integrations';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';

export async function retryPylonEventAction(eventId: string): Promise<ActionResult> {
  if (!validArgs(eventId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await retryPylonEvent(ctx, eventId);
  });
}
