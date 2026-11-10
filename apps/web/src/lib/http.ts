import 'server-only';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { AppError, ValidationError, getConfig, stageUpload, cleanupStaged, type Ctx, type SessionUser, type StagedFile } from '@bluven/core';
import { ctxFor, getCurrentUser } from './session';
import type { ActionResult } from './action-types';

export function json(body: ActionResult | Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Maps a thrown error to a JSON response in the ActionResult shape. */
export function errorResponse(e: unknown): Response {
  if (e instanceof ValidationError) return json({ ok: false, error: e.message, fieldErrors: e.fieldErrors }, 400);
  if (e instanceof AppError) return json({ ok: false, error: e.message }, e.status);
  console.error('[api] unexpected error', e);
  return json({ ok: false, error: 'Something went wrong on our side. Please try again.' }, 500);
}

/**
 * A browser request that changes something must come from our own pages. Together with the
 * SameSite=Lax session cookie this closes the door on cross-site request forgery.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') === 'same-origin';
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  return originHost === host || origin === new URL(getConfig().appUrl).origin;
}

/** Resolves the signed-in user for a route handler, or the error response to send back. */
export async function authenticate(request: Request): Promise<{ user: SessionUser; ctx: Ctx } | Response> {
  if (!['GET', 'HEAD'].includes(request.method) && !sameOrigin(request)) return json({ ok: false, error: 'Cross-site request refused.' }, 403);
  const user = await getCurrentUser();
  if (!user) return json({ ok: false, error: 'Your session has ended. Please sign in again.' }, 401);
  if (user.mustChangePassword) return json({ ok: false, error: 'Choose a new password before continuing.' }, 403);
  return { user, ctx: await ctxFor(user) };
}

/** The request body as a Node stream, for streaming an upload to disk. */
export function bodyStream(request: Request): Readable {
  if (!request.body) throw new ValidationError('The request has no body.');
  return Readable.fromWeb(request.body as unknown as NodeWebStream<Uint8Array>);
}

/** Form endpoints with attachments (contract, deposit proof, quote) are capped well below the general upload limit. */
export const FORM_UPLOAD_LIMIT = 60 * 1024 * 1024;

/** Parses a multipart form, refusing oversized requests before reading them into memory. */
export async function readForm(request: Request): Promise<FormData> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length <= 0) throw new ValidationError('The form is empty.');
  if (length > FORM_UPLOAD_LIMIT) throw new ValidationError(`The attached files are too large. Keep them under ${FORM_UPLOAD_LIMIT / 1024 / 1024} MB in total.`);
  return request.formData();
}

/** Parks the attached files of a form in temporary storage. On failure nothing is left behind. */
export async function stageFiles(list: File[]): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  try {
    for (const file of list) {
      staged.push(await stageUpload(Readable.fromWeb(file.stream() as unknown as NodeWebStream<Uint8Array>), file.name, FORM_UPLOAD_LIMIT));
    }
    return staged;
  } catch (e) {
    await cleanupStaged(staged);
    throw e;
  }
}
