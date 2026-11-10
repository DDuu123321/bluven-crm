import { getDb } from '@bluven/db';

/** Liveness probe for systems that forward leads. Unauthenticated and reveals nothing beyond "up". */
export async function GET(): Promise<Response> {
  try {
    await getDb().$queryRaw`SELECT 1`;
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
