// Keeping a secret (a mailbox's refresh token) in the database without it being readable there.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const TAG_BYTES = 16;

function keyFrom(material: string, purpose: string): Buffer {
  if (!material) throw new Error('No key material to protect secrets with.');
  return Buffer.from(hkdfSync('sha256', material, 'bluven-crm', purpose, 32));
}

/**
 * Encrypts a secret with a key derived from `material` (a server-side secret that is not in the
 * database). AES-256-GCM: a value that was altered, or sealed for another purpose, does not open.
 */
export function sealSecret(plain: string, material: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(material, purpose), iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** Returns the secret, or null when it cannot be opened (another key, or a damaged value). */
export function openSecret(sealed: string, material: string, purpose: string): string | null {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || body === undefined) return null;
  try {
    // A shortened tag would be accepted by the cipher and is far easier to forge: only the full length opens.
    const tagBytes = Buffer.from(tag, 'base64url');
    if (tagBytes.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(material, purpose), Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
