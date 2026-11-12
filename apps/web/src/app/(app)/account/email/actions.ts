'use server';

import { disconnectMailbox } from '@bluven/integrations';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';

/** Disconnects the signed-in person's own mailbox, or, for a manager, somebody else's. */
export async function disconnectMailboxAction(userId?: string): Promise<ActionResult> {
  if (userId !== undefined && !validArgs(userId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await disconnectMailbox(ctx, { userId });
    return { message: 'Disconnected.' };
  });
}
