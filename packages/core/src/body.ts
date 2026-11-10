/**
 * Reads a request body as text while enforcing a size limit, whether or not Content-Length was
 * sent. Returns null when the body is larger than the limit; the rest is then never read into
 * memory. Web frameworks put no limit on the body of a plain HTTP handler, so every endpoint that
 * takes a body from outside (lead intake, webhooks) reads it through this.
 */
export async function readTextBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
