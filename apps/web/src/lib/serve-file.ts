import 'server-only';
import { Readable } from 'node:stream';
import { getStorage } from '@bluven/core';

export interface ServeOptions {
  storageKey: string;
  fileName: string;
  contentType: string;
  /** Show in the browser instead of downloading. Only pass true for types that are safe to render. */
  inline: boolean;
  /** Seconds the browser may keep a private copy. Zero means never store. */
  maxAge?: number;
}

function disposition(inline: boolean, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Streams a stored file, honouring a single byte range so previews and large downloads can seek. */
export async function serveFile(request: Request, opts: ServeOptions): Promise<Response> {
  const storage = getStorage();
  const size = await storage.size(opts.storageKey);
  if (size === null) return new Response('This file is missing from storage.', { status: 404 });

  const headers = new Headers({
    'Content-Type': opts.contentType,
    'Content-Disposition': disposition(opts.inline, opts.fileName),
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.maxAge ? `private, max-age=${opts.maxAge}` : 'private, no-store',
  });
  // Images never need scripts or network access; lock them down completely.
  if (opts.contentType.startsWith('image/')) headers.set('Content-Security-Policy', "default-src 'none'; sandbox");

  const head = request.method === 'HEAD';
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (range && (range[1] || range[2]) && size > 0) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    start = Math.max(0, start);
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    // A HEAD response has no body. Opening the file for it would leave the handle open for good.
    if (head) return new Response(null, { status: 206, headers });
    return new Response(Readable.toWeb(storage.createReadStream(opts.storageKey, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  if (head) return new Response(null, { headers });
  return new Response(Readable.toWeb(storage.createReadStream(opts.storageKey)) as ReadableStream, { headers });
}
