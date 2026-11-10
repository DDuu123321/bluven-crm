import { navCounts } from '@/lib/counts';
import { authenticate } from '@/lib/http';

/** The counters in the navigation. Polled by every open tab, so it does not count as using the application. */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request, { passive: true });
  if (auth instanceof Response) return auth;
  return Response.json(await navCounts(auth.ctx, auth.user), { headers: { 'Cache-Control': 'no-store' } });
}
