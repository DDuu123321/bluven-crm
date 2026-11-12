import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { can, getConfig } from '@bluven/core';
import { zohoAuthorizeUrl, zohoSettings } from '@bluven/integrations';
import { getCurrentUser } from '@/lib/session';

const ZOHO_STATE_COOKIE = 'bluven_zoho_state';

/**
 * Starts connecting the signed-in person's mailbox: sends the browser to Zoho's consent page.
 * A random value travels there and back, and is kept in a cookie meanwhile, so that the answer
 * can only complete a connection this same browser asked for.
 */
export async function GET(): Promise<Response> {
  const base = getConfig().appUrl;
  const user = await getCurrentUser();
  if (!user) return Response.redirect(`${base}/login`, 303);
  const settings = zohoSettings();
  if (!settings || !can(user, 'orders.work')) return Response.redirect(`${base}/account/email?problem=${settings ? 'role' : 'setup'}`, 303);

  const state = randomBytes(24).toString('base64url');
  (await cookies()).set(ZOHO_STATE_COOKIE, `${state}.${user.id}`, {
    httpOnly: true,
    // Lax, not Strict: the cookie has to come back on the redirect from Zoho.
    sameSite: 'lax',
    secure: base.startsWith('https://'),
    path: '/api/zoho',
    maxAge: 600,
  });
  return Response.redirect(zohoAuthorizeUrl(settings, state), 303);
}
