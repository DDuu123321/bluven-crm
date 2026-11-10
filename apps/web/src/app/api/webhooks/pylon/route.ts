// Receives events from Pylon. The handler only authenticates and stores the event; the worker
// processes it, so Pylon always gets its answer well inside the 10 seconds it allows.
import { getConfig, readTextBody } from '@bluven/core';
import { getDb } from '@bluven/db';
import { recordPylonEvent, verifyPylonSignature } from '@bluven/integrations';

const MAX_BODY_BYTES = 1024 * 1024;

function reply(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  const secret = getConfig().pylon.webhookSecret;
  if (!secret) return reply({ error: 'The Pylon webhook is not configured on this server.' }, 503);

  // The signature covers the body byte for byte, so it is read as text before any parsing.
  // Nobody is authenticated yet at this point, so the read is capped: an oversized or endless
  // body is dropped instead of being collected in memory.
  const rawBody = await readTextBody(request, MAX_BODY_BYTES);
  if (rawBody === null) return reply({ error: 'Body too large.' }, 413);

  const verdict = verifyPylonSignature({
    secret,
    timestamp: request.headers.get('pylon-webhook-timestamp'),
    signature: request.headers.get('pylon-webhook-signature'),
    rawBody,
  });
  if (!verdict.ok) return reply({ error: 'Signature verification failed.' }, 401);

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return reply({ error: 'Body is not valid JSON.' }, 400);
  }
  try {
    const stored = await recordPylonEvent(getDb(), body);
    return reply({ ok: true, duplicate: stored.duplicate }, 200);
  } catch (e) {
    if (e instanceof Error && e.name === 'ValidationError') return reply({ error: e.message }, 400);
    console.error('[pylon] could not store event', e);
    // A 5xx makes Pylon deliver the event again later.
    return reply({ error: 'Could not store the event.' }, 500);
  }
}
