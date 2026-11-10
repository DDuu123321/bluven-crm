import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureInput {
  secret: string;
  /** Value of the Pylon-Webhook-Timestamp header. */
  timestamp: string | null;
  /** Value of the Pylon-Webhook-Signature header. */
  signature: string | null;
  /** The request body exactly as received. */
  rawBody: string;
  now?: Date;
}

/**
 * Pylon retries a failed delivery for about 31 hours. A retry may carry its original timestamp,
 * so the accepted window covers the whole retry schedule. Replays inside the window are harmless:
 * events are stored by their id and a repeated delivery is a no-op.
 */
const TOLERANCE_SECONDS = 36 * 60 * 60;

/**
 * Verifies a Pylon webhook: the signature header is "hs256=" followed by the hex HMAC-SHA256 of
 * "<timestamp>.<raw body>" keyed with the destination's secret.
 */
export function verifyPylonSignature(input: SignatureInput): { ok: true } | { ok: false; reason: string } {
  if (!input.secret) return { ok: false, reason: 'no secret configured' };
  if (!input.timestamp || !input.signature) return { ok: false, reason: 'missing signature headers' };
  if (!/^\d{9,12}$/.test(input.timestamp)) return { ok: false, reason: 'malformed timestamp' };
  const age = Math.abs((input.now ?? new Date()).getTime() / 1000 - Number(input.timestamp));
  if (age > TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp outside the accepted window' };

  const expected = Buffer.from(`hs256=${createHmac('sha256', input.secret).update(`${input.timestamp}.${input.rawBody}`).digest('hex')}`);
  const given = Buffer.from(input.signature.trim());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

/** Builds the headers Pylon would send. For tests and for the "send a test event" tooling. */
export function signPylonPayload(secret: string, rawBody: string, now: Date = new Date()): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    'Pylon-Webhook-Timestamp': timestamp,
    'Pylon-Webhook-Signature': `hs256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`,
    'Pylon-Webhook-Version': '2021-07',
  };
}
