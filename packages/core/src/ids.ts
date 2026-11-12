import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

/**
 * A ULID: 48 bits of time followed by 80 random bits, Crockford base32.
 *
 * Monotonic within a process: ids generated in the same millisecond (or after the clock stepped
 * back) increment the random part, so sorting by id always reproduces creation order. The
 * timeline relies on this to order entries that share a timestamp.
 */
export function ulid(now: number = Date.now()): string {
  if (now > lastTime) {
    lastTime = now;
    const bytes = randomBytes(16);
    // 256 is a multiple of 32, so the modulo keeps the distribution uniform.
    lastRandom = Array.from(bytes, (b) => b % 32);
    // Leave headroom so increments within one millisecond cannot overflow.
    lastRandom[0] = lastRandom[0]! % 16;
  } else {
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i]! < 31) {
        lastRandom[i]!++;
        break;
      }
      lastRandom[i] = 0;
    }
  }
  let time = '';
  let t = lastTime;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  return time + lastRandom.map((d) => ALPHABET[d]).join('');
}

export type IdPrefix =
  | 'usr'
  | 'ses'
  | 'cus'
  | 'cem'
  | 'cph'
  | 'prp'
  | 'ord'
  | 'src'
  | 'rcp'
  | 'lrs'
  | 'quo'
  | 'con'
  | 'dep'
  | 'dty'
  | 'doc'
  | 'act'
  | 'tsk'
  | 'ntf'
  | 'hof'
  | 'aud'
  | 'pye'
  | 'mbx'
  | 'eml'
  | 'ema'
  | 'etp'
  | 'air'
  | 'bil';

/** Prefixed id, e.g. ord_01JCK8Q0V9X3M2N4P5R6S7T8U9. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
