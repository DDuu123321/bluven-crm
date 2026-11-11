import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { clientAddress, getConfig, getSessionUser, userCtx, type Ctx, type SessionUser } from '@bluven/core';
import { getDb } from '@bluven/db';

export const SESSION_COOKIE = 'bluven_session';

/** Cookie attributes for the session. Secure whenever the site is served over HTTPS. */
export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: getConfig().appUrl.startsWith('https://'),
    path: '/',
    expires,
  };
}

/** The signed-in user, resolved once per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getSessionUser(getDb(), token);
});

/**
 * The signed-in user for requests the page makes by itself in the background. Such a request
 * shows that a tab is open, not that a person is there, so it does not keep the session alive.
 */
export async function getCurrentUserPassive(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getSessionUser(getDb(), token, new Date(), { passive: true });
}

/** Client address and browser, for the audit log and the sign-in limits. */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ip: clientAddress(h), userAgent: h.get('user-agent') };
}

export async function ctxFor(user: SessionUser): Promise<Ctx> {
  return userCtx(getDb(), { id: user.id, name: user.name, email: user.email, roles: user.roles }, await requestMeta());
}

/** For pages: the signed-in user and a service context, or a redirect to the sign-in page. */
export async function requireSession(opts: { allowPasswordChange?: boolean } = {}): Promise<{ user: SessionUser; ctx: Ctx }> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword && !opts.allowPasswordChange) redirect('/account/password');
  return { user, ctx: await ctxFor(user) };
}
