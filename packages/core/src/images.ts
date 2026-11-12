// Pictures prepared for reading by a program rather than for showing to a person.
import sharp from 'sharp';
import { getStorage } from './storage';

/** Longest side, in pixels. Enough to read the print on a photographed bill. */
const READING_SIZE = 2_000;

/**
 * A stored picture turned upright, scaled down to at most 2000 pixels on its longer side and
 * re-encoded as JPEG. Null when the file cannot be decoded as a picture.
 */
export async function imageForReading(storageKey: string): Promise<Buffer | null> {
  try {
    return await sharp(getStorage().absolutePath(storageKey), { failOn: 'none' })
      .rotate()
      .resize(READING_SIZE, READING_SIZE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return null;
  }
}
