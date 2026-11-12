// Getting a stored file into a form the model can read.
import { readFile } from 'node:fs/promises';
import { getStorage, imageForReading } from '@bluven/core';
import type { AiInput } from './model';

/** A PDF larger than this is not sent: the request as a whole may not pass 32 MB once encoded. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Pictures smaller than this are logos and signature graphics, not photographs or scans. */
export const MIN_IMAGE_BYTES = 20 * 1024;

const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic']);

export type ReadableFile = { ok: true; input: AiInput } | { ok: false; reason: string };

/** Whether a file of this type can be shown to the model at all. */
export function isReadableType(mimeType: string): boolean {
  return mimeType === 'application/pdf' || IMAGE_TYPES.has(mimeType);
}

/** Loads a stored PDF or picture for the model, or says why it cannot be read. */
export async function loadForModel(file: { storageKey: string; mimeType: string; fileName: string; sizeBytes: number }): Promise<ReadableFile> {
  if (file.mimeType === 'application/pdf') {
    if (file.sizeBytes > MAX_PDF_BYTES) return { ok: false, reason: 'The PDF is too large to be read.' };
    try {
      return { ok: true, input: { type: 'pdf', data: await readFile(getStorage().absolutePath(file.storageKey)), title: file.fileName } };
    } catch {
      return { ok: false, reason: 'The file is no longer in storage.' };
    }
  }
  if (IMAGE_TYPES.has(file.mimeType)) {
    const data = await imageForReading(file.storageKey);
    return data ? { ok: true, input: { type: 'image', mediaType: 'image/jpeg', data } } : { ok: false, reason: 'The picture could not be opened.' };
  }
  return { ok: false, reason: 'Only PDFs and pictures can be read.' };
}
