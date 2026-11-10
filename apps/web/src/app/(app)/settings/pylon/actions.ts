'use server';

import { retryPylonEvent } from '@bluven/integrations';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';

export async function retryPylonEventAction(eventId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await retryPylonEvent(ctx, eventId);
  });
}
