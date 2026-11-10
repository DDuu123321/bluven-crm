'use server';

import {
  assignOrders,
  checkLeadDuplicate,
  createLeadManually,
  isManager,
  returnOrdersToPool,
  transferOrders,
  type DuplicateHint,
} from '@bluven/core';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { bool, list, str } from '@/lib/form';
import { ctxFor, getCurrentUser } from '@/lib/session';
import { allow } from '@/lib/rate-limit';

export async function assignAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const orderIds = list(formData, 'orderId');
    const ownerId = str(formData, 'ownerId');
    if (ownerId === '__pool__') {
      const { changed } = await returnOrdersToPool(ctx, { orderIds, note: str(formData, 'note') });
      return { message: `${changed} order${changed === 1 ? '' : 's'} returned to the pool.` };
    }
    const { changed } = await assignOrders(ctx, { orderIds, ownerId });
    return { message: `${changed} order${changed === 1 ? '' : 's'} assigned.` };
  });
}

export async function transferAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const { changed } = await transferOrders(ctx, {
      fromUserId: str(formData, 'fromUserId'),
      toUserId: str(formData, 'toUserId'),
      onlyOpen: bool(formData, 'onlyOpen'),
    });
    return { message: `${changed} order${changed === 1 ? '' : 's'} transferred.` };
  });
}

export async function createLeadAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx, user) => {
    const raw: Record<string, unknown> = {};
    for (const key of ['firstName', 'lastName', 'phone', 'email', 'address', 'suburb', 'state', 'postcode', 'propertyType', 'systemKw', 'batteryKwh', 'monthlyBill', 'timeline', 'bestTime', 'notes']) {
      const value = str(formData, key);
      if (value) raw[key] = value;
    }
    const components = list(formData, 'components');
    if (components.length) raw.components = components;
    const owner = str(formData, 'ownerId');
    const result = await createLeadManually(ctx, raw, isManager(user) ? { ownerId: owner === '__auto__' ? undefined : owner === '__pool__' ? null : owner } : {});
    return { redirectTo: `/orders/${result.orderId}${result.status === 'duplicate' ? '?notice=merged' : ''}` };
  });
}

/** Looks up a possible duplicate while the form is being filled in. */
export async function duplicateHintAction(phone: string, email: string): Promise<DuplicateHint | null> {
  if (typeof phone !== 'string' || typeof email !== 'string' || phone.length > 40 || email.length > 254) return null;
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword) return null;
  // The hint is a convenience while typing. Capped per person, so it cannot be used to run a
  // list of numbers against the customer base; saving a lead applies the rule regardless.
  if (!allow(`duplicate-hint:${user.id}`, 60, 10 * 60_000)) return null;
  try {
    return await checkLeadDuplicate(await ctxFor(user), { phone, email });
  } catch {
    return null;
  }
}
