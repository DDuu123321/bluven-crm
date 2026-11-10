// File storage on the local disk, behind a small interface so it can later move to object storage.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getConfig } from './config';
import { ValidationError } from './errors';

export class FileTooLargeError extends ValidationError {
  constructor(maxBytes: number) {
    super(`The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }
}

export interface TempFile {
  tempPath: string;
  sizeBytes: number;
  sha256: string;
  /** The first bytes of the file, for content sniffing. */
  head: Buffer;
}

const KEY_RE = /^[A-Za-z0-9_\-]+(?:[./][A-Za-z0-9_\-]+)*$/;

export class LocalStorage {
  constructor(readonly root: string) {}

  /** Absolute path of a storage key. Rejects anything that could escape the root. */
  absolutePath(key: string): string {
    if (!KEY_RE.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
    return path.join(this.root, key);
  }

  /**
   * Streams the body into a temporary file while hashing it. Fails with FileTooLargeError as
   * soon as the limit is passed, and removes the partial file on any error.
   */
  async writeTemp(body: Readable, maxBytes: number): Promise<TempFile> {
    const dir = path.join(this.root, '.tmp');
    await mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `${Date.now()}-${randomBytes(8).toString('hex')}.upload`);
    const hash = createHash('sha256');
    const headChunks: Buffer[] = [];
    let headBytes = 0;
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) return done(new FileTooLargeError(maxBytes));
        hash.update(chunk);
        if (headBytes < 64) {
          headChunks.push(chunk.subarray(0, 64 - headBytes));
          headBytes += chunk.length;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tempPath, { flags: 'wx' }));
    } catch (e) {
      await rm(tempPath, { force: true });
      throw e;
    }
    return { tempPath, sizeBytes, sha256: hash.digest('hex'), head: Buffer.concat(headChunks).subarray(0, 64) };
  }

  /** Moves a temporary file to its final key. */
  async commit(tempPath: string, key: string): Promise<void> {
    const target = this.absolutePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(tempPath, target);
  }

  async discard(tempPath: string): Promise<void> {
    await rm(tempPath, { force: true });
  }

  async remove(key: string): Promise<void> {
    await rm(this.absolutePath(key), { force: true });
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.absolutePath(key))).size;
    } catch {
      return null;
    }
  }

  createReadStream(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.absolutePath(key), range);
  }

  async writeBuffer(key: string, data: Buffer): Promise<void> {
    const target = this.absolutePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

let storage: LocalStorage | undefined;

export function getStorage(): LocalStorage {
  storage ??= new LocalStorage(getConfig().storageDir);
  return storage;
}

/** For tests. */
export function setStorage(next: LocalStorage | undefined): void {
  storage = next;
}

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

const EXTENSION_TYPES: Record<string, string> = {
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
};

/** Types a browser may display in place. Everything else is always sent as a download. */
export const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

export const THUMBNAIL_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Decides the content type from the file's first bytes. The extension is only trusted for types
 * that are never rendered in the browser, so a script renamed to .pdf cannot be served inline.
 */
export function detectContentType(fileName: string, head: Buffer): string {
  const ascii = head.toString('latin1');
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  if (ascii.slice(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heim|heis)/.test(ascii.slice(8, 12))) return 'image/heic';
  return EXTENSION_TYPES[safeExtension(fileName)] ?? 'application/octet-stream';
}

/** Lower-case extension without the dot, or '' when there is none worth keeping. */
export function safeExtension(fileName: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  return m ? m[1]!.toLowerCase() : '';
}

/** A display name with path separators and control characters removed. */
export function cleanFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'file').slice(0, 200);
}
