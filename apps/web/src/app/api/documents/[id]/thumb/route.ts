import { openDocument } from '@bluven/core';
import { authenticate, errorResponse } from '@/lib/http';
import { serveFile } from '@/lib/serve-file';

/** A small preview of an image document. Same access rules as the document itself; not logged. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    const doc = await openDocument(auth.ctx, { documentId: id, purpose: 'thumbnail' });
    if (!doc.thumbKey) return new Response(null, { status: 404 });
    return await serveFile(request, { storageKey: doc.thumbKey, fileName: `${doc.fileName}.webp`, contentType: 'image/webp', inline: true, maxAge: 3600 });
  } catch (e) {
    return errorResponse(e);
  }
}
