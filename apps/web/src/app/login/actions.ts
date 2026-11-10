'use server';

import { cookies } from 'next/headers';
import { changeOwnPassword, login, logout } from '@bluven/core';
import { getDb } from '@bluven/db';
import { toActionError } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { allow, retryAfter } from '@/lib/rate-limit';
import { SESSION_COOKIE, ctxFor, getCurrentUser, requestMeta, sessionCookieOptions } from '@/lib/session';

const WINDOW_MS = 10 * 60_000;
// The cookie outlives the server-side session, which is what actually decides (14 days, sliding).
const COOKIE_LIFETIME_MS = 90 * 24 * 60 * 60_000;

export async function loginAction(formData: FormData): Promise<ActionResult> {
  const meta = await requestMeta();
  const key = `login:${meta.ip ?? 'unknown'}`;
  if (!allow(key, 20, WINDOW_MS)) {
    return { ok: false, error: `Too many sign-in attempts from this network. Try again in ${Math.ceil(retryAfter(key, WINDOW_MS) / 60)} minutes.` };
  }
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  if (!email.trim() || !password) return { ok: false, error: 'Enter your email and password.' };
  try {
    const session = await login(getDb(), { email, password, ...meta });
    (await cookies()).set(SESSION_COOKIE, session.token, sessionCookieOptions(new Date(Date.now() + COOKIE_LIFETIME_MS)));
    return { ok: true, redirectTo: session.user.mustChangePassword ? '/account/password' : '/' };
  } catch (e) {
    return toActionError(e);
  }
}

export async function logoutAction(): Promise<ActionResult> {
  const jar = await cookies();
  await logout(getDb(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return { ok: true, redirectTo: '/login' };
}

export async function changePasswordAction(formData: FormData): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Your session has ended. Please sign in again.', data: { signedOut: true } };
  const next = String(formData.get('next') ?? '');
  if (next !== String(formData.get('confirm') ?? '')) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors: { confirm: 'The two new passwords do not match.' } };
  }
  try {
    await changeOwnPassword(await ctxFor(user), {
      current: String(formData.get('current') ?? ''),
      next,
      keepToken: (await cookies()).get(SESSION_COOKIE)?.value,
    });
    return { ok: true, redirectTo: '/' };
  } catch (e) {
    return toActionError(e);
  }
}
