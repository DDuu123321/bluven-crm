import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { AppError, getConfig } from '@bluven/core';
import { connectMailbox } from '@bluven/integrations';
import { ctxFor, getCurrentUser } from '@/lib/session';

const STATE_COOKIE = 'bluven_zoho_state';

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Where Zoho sends the browser back to after the person has allowed, or refused, access to their mailbox. */
export async function GET(request: Request): Promise<Response> {
  const base = getConfig().appUrl;
  const back = (query: string) => Response.redirect(`${base}/account/email?${query}`, 303);
  const user = await getCurrentUser();
  if (!user) return Response.redirect(`${base}/login`, 303);

  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value ?? '';
  jar.delete({ name: STATE_COOKIE, path: '/api/zoho' });
  const params = new URL(request.url).searchParams;
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  // The answer must belong to a request this browser made, for this person.
  if (!state || !same(expected, `${state}.${user.id}`)) return back('problem=state');
  if (params.get('error') || !code) return back('problem=declined');

  try {
    await connectMailbox(await ctxFor(user), { code });
    return back('connected=1');
  } catch (e) {
    if (!(e instanceof AppError)) console.error('[zoho] connecting a mailbox failed', e);
    return back(`problem=${e instanceof AppError ? (e.code === 'conflict' ? 'taken' : 'refused') : 'failed'}`);
  }
}
