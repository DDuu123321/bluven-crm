import { openEmailHtml } from '@bluven/integrations';
import { authenticate, errorResponse } from '@/lib/http';

/**
 * Shows an e-mail with its original formatting. The markup comes from outside, so it is served
 * as a document that can do nothing: no scripts, no forms, no network (which also keeps tracking
 * images from loading), and no access to this site, whatever the markup contains.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    const { html } = await openEmailHtml(auth.ctx, id);
    return new Response(`<!doctype html><meta charset="utf-8"><base target="_blank">${html}`, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
