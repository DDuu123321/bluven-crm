import 'server-only';
import { getConfig, parseDateOnly, parseKiloToUnits, parseMoneyToCents, zonedTimeToUtc } from '@bluven/core';

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

/** Dollars typed by a person, as cents. Null when empty or not an amount. */
export function money(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  return s ? parseMoneyToCents(s) : null;
}

/** "6.6" kW or kWh as thousandths (W or Wh). Null when empty or not a number. */
export function kilo(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  return s ? parseKiloToUnits(s) : null;
}

export function int(fd: FormData, name: string): number | null {
  const s = str(fd, name);
  return /^-?\d+$/.test(s) ? Number(s) : null;
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
