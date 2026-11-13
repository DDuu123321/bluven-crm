'use server';

import { disconnectMailbox, setMailboxScope } from '@bluven/integrations';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';

/** Disconnects the signed-in person's own mailbox, or, for a manager, somebody else's. */
export async function disconnectMailboxAction(userId?: string): Promise<ActionResult> {
  if (userId !== undefined && !validArgs(userId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const { revoked } = await disconnectMailbox(ctx, { userId });
    return {
      message: revoked
        ? 'Disconnected.'
        : 'Disconnected: the CRM no longer has access. Zoho did not confirm that the permission is gone on its side too; to be sure, remove the CRM under Connected Apps in the Zoho account.',
    };
  });
}

/** The signed-in person chooses how much of their own mailbox is kept. */
export async function setMailboxScopeAction(scope: string): Promise<ActionResult> {
  if (!validArgs(scope)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await setMailboxScope(ctx, { scope });
    return { message: 'Saved.' };
  });
}
