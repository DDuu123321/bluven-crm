import 'server-only';
import { refresh } from 'next/cache';
import { AppError, DuplicateLeadError, ValidationError, type Ctx, type SessionUser } from '@bluven/core';
import { ctxFor, getCurrentUser } from './session';
import type { ActionResult } from './action-types';

type Outcome = void | { message?: string; redirectTo?: string; data?: Record<string, unknown> };

/** Turns a thrown error into the result shape forms understand. Unknown errors are logged, not leaked. */
export function toActionError(e: unknown): Extract<ActionResult, { ok: false }> {
  if (e instanceof ValidationError) return { ok: false, error: e.message, fieldErrors: e.fieldErrors };
  if (e instanceof DuplicateLeadError) return { ok: false, error: e.message, data: e.orderId ? { orderId: e.orderId } : undefined };
  if (e instanceof AppError) return { ok: false, error: e.message };
  console.error('[action] unexpected error', e);
  return { ok: false, error: 'Something went wrong on our side. Please try again.' };
}

/**
 * Wraps the body of a Server Action: resolves the signed-in user, runs the service call, maps
 * errors, and refreshes the page the user is looking at.
 * Authorisation itself lives in the services; this only establishes who is asking.
 */
export async function runAction(fn: (ctx: Ctx, user: SessionUser) => Promise<Outcome>): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Your session has ended. Please sign in again.', data: { signedOut: true } };
  if (user.mustChangePassword) return { ok: false, error: 'Choose a new password before continuing.' };
  try {
    const out = await fn(await ctxFor(user), user);
    refresh();
    return { ok: true, ...(out ?? {}) };
  } catch (e) {
    return toActionError(e);
  }
}
