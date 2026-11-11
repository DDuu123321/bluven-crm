import 'server-only';
import { ValidationError, getConfig, parseDateOnly, parseKiloToUnits, parseMoneyToCents, zonedTimeToUtc } from '@bluven/core';

/** Trimmed string value of a form field ('' when absent). */
export function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export function bool(fd: FormData, name: string): boolean {
  const v = fd.get(name);
  return v === 'on' || v === 'true' || v === '1';
}

/** All string values of a repeated field. */
export function list(fd: FormData, name: string): string[] {
  return fd
    .getAll(name)
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** A field that holds something the application cannot read. Reported on the field, never dropped. */
function unreadable(name: string, hint: string): never {
  throw new ValidationError('Please correct the highlighted fields.', { [name]: hint });
}

/** Dollars typed by a person, as cents. Null when left empty; an error on the field when it is not an amount. */
export function money(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (!s) return null;
  return parseMoneyToCents(s) ?? unreadable(name, 'Enter an amount such as 1850 or 1,850.00.');
}

/** "6.6" kW or kWh as thousandths (W or Wh). Null when left empty; an error on the field when it is not a number. */
export function kilo(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (!s) return null;
  return parseKiloToUnits(s) ?? unreadable(name, 'Enter a number such as 6.6.');
}

/** A whole number. Null when left empty; an error on the field when it is anything else. */
export function int(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  if (!s) return null;
  return /^-?\d+$/.test(s) ? Number(s) : unreadable(name, 'Enter a whole number.');
}

/** <input type="date"> value as a date-only value. */
export function dateOnly(fd: FormData, name: string): Date | null {
  const s = str(fd, name);
  return s ? parseDateOnly(s) : null;
}

/** <input type="datetime-local"> value, read as business-local time. */
export function dateTime(fd: FormData, name: string): Date | null {
  const s = str(fd, name);
  return s ? zonedTimeToUtc(s, getConfig().timeZone) : null;
}

/** Uploaded files of a field, ignoring the empty placeholder browsers send for an untouched input. */
export function files(fd: FormData, name: string): File[] {
  return fd.getAll(name).filter((v): v is File => typeof v !== 'string' && v.size > 0);
}
