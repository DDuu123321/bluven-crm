// Lead intake for the Bluven website and other sources.
// Contract: docs/bluven-lead-forwarding-spec.md
import { authenticateIntakeToken, ingestLeads, systemCtx } from '@bluven/core';
import { getDb } from '@bluven/db';
import { allow, retryAfter } from '@/lib/rate-limit';

const MAX_BODY_BYTES = 100 * 1024;
const MAX_LEADS = 200;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** Reads the body while enforcing the size limit, whether or not Content-Length was sent. */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(request: Request): Promise<Response> {
  const db = getDb();
  const header = request.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
  const source = token ? await authenticateIntakeToken(db, token) : null;
  if (!source) return reply({ error: 'Missing or invalid token.' }, 401, { 'WWW-Authenticate': 'Bearer' });

  const key = `intake:${source.id}`;
  if (!allow(key, RATE_LIMIT, RATE_WINDOW_MS)) {
    return reply({ error: `Rate limit exceeded: at most ${RATE_LIMIT} requests per minute.` }, 429, { 'Retry-After': String(retryAfter(key, RATE_WINDOW_MS)) });
  }

  const text = await readBody(request);
  if (text === null) return reply({ error: 'Request body is larger than 100 KB. Send fewer leads per request.' }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply({ error: 'Request body is not valid JSON.' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply({ error: 'Request body must be a JSON object with a "leads" array.' }, 400);
  const { leads, backfill, dryRun } = body as Record<string, unknown>;
  if (!Array.isArray(leads)) return reply({ error: '"leads" must be an array.' }, 400);
  if (leads.length < 1 || leads.length > MAX_LEADS) return reply({ error: `"leads" must contain between 1 and ${MAX_LEADS} items.` }, 400);
  if (backfill !== undefined && typeof backfill !== 'boolean') return reply({ error: '"backfill" must be true or false.' }, 400);
  if (dryRun !== undefined && typeof dryRun !== 'boolean') return reply({ error: '"dryRun" must be true or false.' }, 400);

  try {
    const forwarded = request.headers.get('x-forwarded-for');
    const ctx = { ...systemCtx(db, source.name), ip: forwarded ? forwarded.split(',')[0]!.trim() : null, userAgent: request.headers.get('user-agent') };
    const summary = await ingestLeads(ctx, leads, { sourceId: source.id, requireExternalId: true, backfill: backfill === true, dryRun: dryRun === true });
    return reply(summary);
  } catch (e) {
    // Leads already processed in this batch are safe: a retry reports them as already_received.
    console.error('[intake] batch failed', e);
    return reply({ error: 'The batch could not be processed completely. Retry the request; leads that were accepted will be reported as already_received.' }, 500);
  }
}
