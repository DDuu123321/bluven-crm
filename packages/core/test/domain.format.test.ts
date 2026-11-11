import { describe, expect, it } from 'vitest';
import {
  centsToInput,
  dateOnlyString,
  formatBytes,
  formatCents,
  formatDate,
  formatDateTime,
  formatKw,
  formatKwh,
  localDateString,
  localDateTimeInput,
  endOfLocalDay,
  parseDateOnly,
  parseKiloToUnits,
  parseMoneyToCents,
  relativeTime,
  todayDateOnly,
  zonedTimeToUtc,
} from '../src/domain';

describe('money', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(1234550)).toBe('$12,345.50');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(null)).toBe('');
  });
  it('parses common ways of writing an amount', () => {
    expect(parseMoneyToCents('12,345.50')).toBe(1234550);
    expect(parseMoneyToCents('$12345.5')).toBe(1234550);
    expect(parseMoneyToCents('1000')).toBe(100000);
    expect(parseMoneyToCents('0.07')).toBe(7);
    expect(parseMoneyToCents('12.345')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('-5')).toBeNull();
    expect(parseMoneyToCents('')).toBeNull();
  });
  it('accepts a comma only as a thousands separator', () => {
    expect(parseMoneyToCents('1,850')).toBe(185000);
    expect(parseMoneyToCents('$ 1,234,567.89')).toBe(123456789);
    // Written the continental way these mean 900 and 1.5; read the other way they would be
    // a hundred times too much. Refused, so the form can ask.
    expect(parseMoneyToCents('900,00')).toBeNull();
    expect(parseMoneyToCents('1,50')).toBeNull();
    expect(parseMoneyToCents('12,34.50')).toBeNull();
    expect(parseMoneyToCents('1,2345')).toBeNull();
    expect(parseMoneyToCents(',500')).toBeNull();
  });
  it('round-trips through the form representation', () => {
    expect(centsToInput(1234550)).toBe('12345.50');
    expect(parseMoneyToCents(centsToInput(199)!)).toBe(199);
  });
});

describe('system size', () => {
  it('formats watts and watt-hours', () => {
    expect(formatKw(6600)).toBe('6.6 kW');
    expect(formatKw(13200)).toBe('13.2 kW');
    expect(formatKwh(13500)).toBe('13.5 kWh');
    expect(formatKw(null)).toBe('');
  });
  it('parses kilo values without floating point drift', () => {
    expect(parseKiloToUnits('6.6')).toBe(6600);
    expect(parseKiloToUnits('13.5')).toBe(13500);
    expect(parseKiloToUnits('10')).toBe(10000);
    expect(parseKiloToUnits('x')).toBeNull();
  });
});

describe('dates in the business time zone', () => {
  const tz = 'Australia/Sydney';
  it('shows the local calendar date, not the UTC one', () => {
    // 14:30 UTC on 9 Nov is 01:30 on 10 Nov in Sydney (UTC+11 in summer).
    const instant = new Date('2026-11-09T14:30:00Z');
    expect(localDateString(instant, tz)).toBe('2026-11-10');
    expect(formatDate(instant, tz)).toBe('10 Nov 2026');
    expect(formatDateTime(instant, tz)).toMatch(/^10 Nov 2026, 1:30\s?am$/i);
    expect(localDateTimeInput(instant, tz)).toBe('2026-11-10T01:30');
  });
  it('converts local wall-clock time to an instant in summer and winter', () => {
    expect(zonedTimeToUtc('2026-11-10T01:30', tz)?.toISOString()).toBe('2026-11-09T14:30:00.000Z');
    // Winter: UTC+10.
    expect(zonedTimeToUtc('2026-07-01T09:00', tz)?.toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-01', tz)?.toISOString()).toBe('2026-06-30T14:00:00.000Z');
    expect(zonedTimeToUtc('2026-02-30', tz)).toBeNull();
    expect(zonedTimeToUtc('nonsense', tz)).toBeNull();
  });
  it('round-trips datetime-local values', () => {
    for (const text of ['2026-01-15T08:05', '2026-04-05T02:30', '2026-10-04T03:15', '2026-12-31T23:59']) {
      const instant = zonedTimeToUtc(text, tz)!;
      expect(localDateTimeInput(instant, tz)).toBe(text);
    }
  });
  it('handles date-only values', () => {
    const d = parseDateOnly('2026-11-09')!;
    expect(d.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(dateOnlyString(d)).toBe('2026-11-09');
    expect(parseDateOnly('2026-13-01')).toBeNull();
    expect(parseDateOnly('2026-02-31')).toBeNull();
    expect(todayDateOnly(new Date('2026-11-09T14:30:00Z'), tz).toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });
});

describe('misc formatting', () => {
  it('describes relative time', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(relativeTime(new Date('2026-11-10T11:59:40Z'), now)).toBe('just now');
    expect(relativeTime(new Date('2026-11-10T11:15:00Z'), now)).toBe('45 minutes ago');
    expect(relativeTime(new Date('2026-11-10T09:00:00Z'), now)).toBe('3 hours ago');
    expect(relativeTime(new Date('2026-11-07T12:00:00Z'), now)).toBe('3 days ago');
    expect(relativeTime(new Date('2026-11-11T12:00:00Z'), now)).toBe('in 1 day');
  });
  it('formats file sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
    expect(formatBytes(350 * 1024 * 1024)).toBe('350 MB');
  });
});

describe('the end of a business day', () => {
  it('is midnight at the start of the next day, also when the day is not 24 hours long', () => {
    // An ordinary day in summer time (UTC+11).
    expect(endOfLocalDay('2026-11-10', 'Australia/Sydney')!.toISOString()).toBe('2026-11-10T13:00:00.000Z');
    // Daylight saving ends on 5 April 2026: the day has 25 hours and the next midnight is at UTC+10.
    expect(endOfLocalDay('2026-04-05', 'Australia/Sydney')!.toISOString()).toBe('2026-04-05T14:00:00.000Z');
    expect(endOfLocalDay('2026-04-05', 'Australia/Sydney')!.getTime() - zonedTimeToUtc('2026-04-05', 'Australia/Sydney')!.getTime()).toBe(25 * 3_600_000);
    // It starts on 4 October 2026: the day has 23 hours.
    expect(endOfLocalDay('2026-10-04', 'Australia/Sydney')!.getTime() - zonedTimeToUtc('2026-10-04', 'Australia/Sydney')!.getTime()).toBe(23 * 3_600_000);
    // Month and year ends roll over.
    expect(endOfLocalDay('2026-12-31', 'Australia/Sydney')!.toISOString()).toBe('2026-12-31T13:00:00.000Z');
    expect(endOfLocalDay('not a date')).toBeNull();
  });
});
