import { describe, expect, it } from 'vitest';
import { newId, ulid } from '../src';

describe('ids', () => {
  it('are 26 characters of Crockford base32 with a prefix', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId('ord')).toMatch(/^ord_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sort in creation order, even within one millisecond and when the clock steps back', () => {
    const ids: string[] = [];
    const t = Date.now() + 10_000;
    for (let i = 0; i < 5000; i++) ids.push(ulid(t));
    ids.push(ulid(t - 5)); // clock stepped back
    ids.push(ulid(t + 1));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
