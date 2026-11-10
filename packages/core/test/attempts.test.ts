import { describe, expect, it } from 'vitest';
import { FailureLimiter, networkKey } from '../src';

describe('failure limiter', () => {
  it('blocks after the limit inside the window and says for how long', () => {
    const limiter = new FailureLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.blockedFor('a', t0)).toBe(0);
    limiter.record('a', t0);
    limiter.record('a', t0 + 10_000);
    expect(limiter.blockedFor('a', t0 + 15_000)).toBe(0);
    limiter.record('a', t0 + 20_000);
    expect(limiter.blockedFor('a', t0 + 21_000)).toBe(39); // until the first of the three is a minute old
    expect(limiter.blockedFor('b', t0 + 21_000)).toBe(0);
    expect(limiter.blockedFor('a', t0 + 60_001)).toBe(0);
    limiter.clear('a');
    expect(limiter.blockedFor('a', t0 + 21_000)).toBe(0);
  });

  it('never tracks more keys than its cap, however many are thrown at it', () => {
    const limiter = new FailureLimiter(5, 60_000, 1_000);
    for (let i = 0; i < 25_000; i++) limiter.record(`made-up-${i}`, 1_000_000 + i);
    expect(limiter.size).toBeLessThanOrEqual(1_000);
    // The most recent keys are the ones kept.
    expect(limiter.blockedFor('made-up-24999', 1_030_000)).toBe(0);
    for (let i = 0; i < 4; i++) limiter.record('made-up-24999', 1_030_000);
    expect(limiter.blockedFor('made-up-24999', 1_030_000)).toBeGreaterThan(0);
  });
});

describe('network of a client address', () => {
  it('uses an IPv4 address as it is', () => {
    expect(networkKey('203.0.113.7')).toBe('203.0.113.7');
    expect(networkKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 addresses by their /64', () => {
    expect(networkKey('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3::/64');
    expect(networkKey('2001:0db8:85a3:08d3:ffff:ffff:ffff:ffff')).toBe('2001:db8:85a3:8d3::/64');
    expect(networkKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(networkKey('2001:db8::abcd:0:0:1')).toBe(networkKey('2001:db8::1'));
    expect(networkKey('::1')).toBe('0:0:0:0::/64');
  });

  it('has no key when there is no address', () => {
    expect(networkKey(null)).toBeNull();
    expect(networkKey('  ')).toBeNull();
  });
});
