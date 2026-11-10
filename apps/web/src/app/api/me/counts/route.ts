import { navCounts } from '@/lib/counts';
import { authenticate } from '@/lib/http';

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  return Response.json(await navCounts(auth.ctx, auth.user), { headers: { 'Cache-Control': 'no-store' } });
}
