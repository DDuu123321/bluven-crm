import { openEmailAttachment } from '@bluven/integrations';
import { authenticate, errorResponse } from '@/lib/http';
import { serveFile } from '@/lib/serve-file';

/** Sends an attachment a customer e-mailed, after checking that the user may read that correspondence. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const download = new URL(request.url).searchParams.get('download') === '1';
  try {
    const file = await openEmailAttachment(auth.ctx, { attachmentId: id, purpose: request.method === 'HEAD' ? 'head' : 'download' });
    const inline = !download && file.inlineSafe;
    // What a stranger sent is only ever shown in place when it is a kind browsers render safely.
    return await serveFile(request, { storageKey: file.storageKey, fileName: file.fileName, contentType: file.inlineSafe || download ? file.mimeType : 'application/octet-stream', inline });
  } catch (e) {
    return errorResponse(e);
  }
}
