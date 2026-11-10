// Formatting and parsing helpers shared by server and browser code. Pure functions.

export const DEFAULT_TIMEZONE = 'Australia/Sydney';

/** "$12,345.00" */
export function formatCents(cents: number | null | undefined, currency = 'AUD'): string {
  if (cents === null || cents === undefined) return '';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(cents / 100);
}

/** Parses "12,345.50", "$12345.5" or "12345" into cents. Returns null when the text is not an amount. */
export function parseMoneyToCents(text: string): number | null {
  const s = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= 2_000_000_000 ? cents : null;
}

/** Cents as a plain decimal for form fields: 123450 -> "1234.50". */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

/** "6.6 kW" from watts. */
export function formatKw(watts: number | null | undefined): string {
  if (watts === null || watts === undefined) return '';
  return `${trimNumber(watts / 1000)} kW`;
}

/** "13.5 kWh" from watt-hours. */
export function formatKwh(wattHours: number | null | undefined): string {
  if (wattHours === null || wattHours === undefined) return '';
  return `${trimNumber(wattHours / 1000)} kWh`;
}

function trimNumber(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Parses a decimal such as "6.6" into thousandths (kW -> W). Null when not a non-negative number. */
export function parseKiloToUnits(text: string): number | null {
  const s = text.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * 1000);
  return Number.isSafeInteger(n) && n <= 2_000_000_000 ? n : null;
}

export function unitsToKiloInput(units: number | null | undefined): string {
  if (units === null || units === undefined) return '';
  return trimNumber(units / 1000);
}

function parts(date: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** "9 Nov 2026" in the business time zone. */
export function formatDate(date: Date | null | undefined, timeZone = DEFAULT_TIMEZONE): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

/** "9 Nov 2026, 2:05 pm" in the business time zone. */
export function formatDateTime(date: Date | null | undefined, timeZone = DEFAULT_TIMEZONE): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** Calendar date ("YYYY-MM-DD") of an instant in the business time zone. */
export function localDateString(date: Date, timeZone = DEFAULT_TIMEZONE): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Value for <input type="datetime-local"> in the business time zone. */
export function localDateTimeInput(date: Date, timeZone = DEFAULT_TIMEZONE): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Offset of the time zone from UTC, in minutes, at the given instant. */
function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/**
 * Interprets a wall-clock "YYYY-MM-DDTHH:mm" (or "YYYY-MM-DD", meaning midnight) in the business
 * time zone and returns the instant. Null when the text is not a valid date.
 */
export function zonedTimeToUtc(text: string, timeZone = DEFAULT_TIMEZONE): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59) return null;
  // Two passes settle the offset around daylight-saving changes.
  let utc = guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60000;
  utc = guess - zoneOffsetMinutes(new Date(utc), timeZone) * 60000;
  return new Date(utc);
}

// ---- date-only values (stored as UTC midnight in @db.Date columns)

/** Parses "YYYY-MM-DD" into a UTC-midnight Date for a date-only column. Null when invalid. */
export function parseDateOnly(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]) ? date : null;
}

/** "YYYY-MM-DD" of a date-only value. */
export function dateOnlyString(date: Date | null | undefined): string {
  if (!date) return '';
  return date.toISOString().slice(0, 10);
}

/** "9 Nov 2026" of a date-only value. */
export function formatDateOnly(date: Date | null | undefined): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

/** Today's calendar date in the business time zone, as a date-only value. */
export function todayDateOnly(now: Date, timeZone = DEFAULT_TIMEZONE): Date {
  return parseDateOnly(localDateString(now, timeZone))!;
}

/** "3 days ago", "in 2 hours", "just now". */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = date.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const units: [number, string][] = [
    [60_000, 'minute'],
    [3_600_000, 'hour'],
    [86_400_000, 'day'],
  ];
  if (abs < 60_000) return 'just now';
  let value = Math.floor(abs / 60_000);
  let unit = 'minute';
  for (const [ms, name] of units) {
    if (abs >= ms) {
      value = Math.floor(abs / ms);
      unit = name;
    }
  }
  const label = `${value} ${unit}${value === 1 ? '' : 's'}`;
  return diffMs < 0 ? `${label} ago` : `in ${label}`;
}

/** "2.4 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10} ${units[i]}`;
}

export function fullName(c: { firstName: string; lastName?: string | null }): string {
  return [c.firstName, c.lastName ?? ''].map((s) => s.trim()).filter(Boolean).join(' ');
}
