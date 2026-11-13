import { afterEach, describe, expect, it } from 'vitest';
import { getConfig, openSecret, resetConfigCache, sealSecret } from '../src';

describe('sealed secrets', () => {
  it('opens only with its whole authentication tag', () => {
    const sealed = sealSecret('1000.refresh-token', 'client-secret', 'mail-token');
    const [version, iv, tag, body] = sealed.split('.');
    expect(Buffer.from(tag!, 'base64url')).toHaveLength(16);
    expect(openSecret(sealed, 'client-secret', 'mail-token')).toBe('1000.refresh-token');
    // The cipher itself would accept a tag cut down to four bytes, which is easy to guess.
    for (const bytes of [4, 8, 12, 15]) {
      const short = Buffer.from(tag!, 'base64url').subarray(0, bytes).toString('base64url');
      expect(openSecret([version, iv, short, body].join('.'), 'client-secret', 'mail-token')).toBeNull();
    }
    expect(openSecret([version, iv, '', body].join('.'), 'client-secret', 'mail-token')).toBeNull();
  });
});

describe('how fast the mail service is asked', () => {
  const before = process.env.ZOHO_REQUESTS_PER_MINUTE;
  afterEach(() => {
    if (before === undefined) delete process.env.ZOHO_REQUESTS_PER_MINUTE;
    else process.env.ZOHO_REQUESTS_PER_MINUTE = before;
    resetConfigCache();
  });
  const rate = (value: string | undefined): number => {
    if (value === undefined) delete process.env.ZOHO_REQUESTS_PER_MINUTE;
    else process.env.ZOHO_REQUESTS_PER_MINUTE = value;
    resetConfigCache();
    return getConfig().zoho.requestsPerMinute;
  };

  it('stays under the 30 a minute Zoho allows unless told otherwise, and within sensible bounds', () => {
    expect(rate(undefined)).toBe(24);
    expect(rate('12')).toBe(12);
    expect(rate('0')).toBe(24);
    expect(rate('fast')).toBe(24);
    expect(rate('5000')).toBe(120);
  });
});
