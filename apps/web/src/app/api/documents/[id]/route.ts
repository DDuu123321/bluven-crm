import { openDocument } from '@bluven/core';
import { authenticate, errorResponse } from '@/lib/http';
import { serveFile } from '@/lib/serve-file';

/**
 * Sends a document's bytes after checking that the user may see it. Every view and download is
 * written to the audit log. Add ?download=1 to force a download.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const download = new URL(request.url).searchParams.get('download') === '1';
  try {
    // A ranged follow-up request for the same file is part of the same viewing, not a new one.
    const continuation = /^bytes=[1-9]/.test(request.headers.get('range') ?? '');
    const doc = await openDocument(auth.ctx, { documentId: id, purpose: continuation ? 'thumbnail' : download ? 'download' : 'view' });
    const inline = !download && doc.inlineSafe;
    return await serveFile(request, {
      storageKey: doc.storageKey,
      fileName: doc.fileName,
      // Anything a browser might try to render and that we have not verified goes out as a plain download.
      contentType: doc.inlineSafe || download ? doc.mimeType : 'application/octet-stream',
      inline,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
