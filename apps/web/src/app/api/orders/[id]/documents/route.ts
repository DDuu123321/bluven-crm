import { FileTooLargeError, getConfig, uploadDocument } from '@bluven/core';
import { authenticate, bodyStream, errorResponse, json } from '@/lib/http';

/**
 * Streams one file into an order's folder. The file is the raw request body; its name and
 * destination come from the query string. Nothing is buffered in memory, so large files are fine.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const url = new URL(request.url);
  try {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > getConfig().maxUploadBytes) throw new FileTooLargeError(getConfig().maxUploadBytes);
    const doc = await uploadDocument(auth.ctx, {
      orderId: id,
      typeId: url.searchParams.get('typeId') ?? '',
      fileName: url.searchParams.get('name') ?? 'file',
      replacesId: url.searchParams.get('replaces'),
      body: bodyStream(request),
    });
    return json({ ok: true, data: { id: doc.id } });
  } catch (e) {
    return errorResponse(e);
  }
}
