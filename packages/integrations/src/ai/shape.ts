// Small helpers for checking the shape of what the model answered. The service already holds the
// model to the schema; these make sure nothing unexpected reaches the database or a page anyway.
import { unusable } from './runs';

export function record(value: unknown, what = 'answer'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unusable(`The ${what} is not an object.`);
  return value as Record<string, unknown>;
}

/** A string field, trimmed and cut to `max` characters. */
export function text(o: Record<string, unknown>, key: string, max = 2_000): string {
  const v = o[key];
  if (typeof v !== 'string') throw unusable(`“${key}” is missing.`);
  return v.trim().slice(0, max);
}

/** A string field that may be null. */
export function optionalText(o: Record<string, unknown>, key: string, max = 500): string {
  const v = o[key];
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw unusable(`“${key}” is not text.`);
  return v.trim().slice(0, max);
}

/** A number field that may be null. Anything that is not a finite number of a sensible size reads as null. */
export function optionalNumber(o: Record<string, unknown>, key: string, { min = 0, max = 1e9 }: { min?: number; max?: number } = {}): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** A list of short texts: empty entries dropped, at most `maxItems` kept. */
export function textList(o: Record<string, unknown>, key: string, maxItems = 12, max = 600): string[] {
  const v = o[key];
  if (!Array.isArray(v)) throw unusable(`“${key}” is not a list.`);
  return v
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, max))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function records(o: Record<string, unknown>, key: string, maxItems = 20): Record<string, unknown>[] {
  const v = o[key];
  if (!Array.isArray(v)) throw unusable(`“${key}” is not a list.`);
  return v.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item)).slice(0, maxItems);
}

/** One of a fixed set of words. */
export function choice<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw unusable(`“${key}” is not one of the allowed values.`);
  return v as T;
}

/** A calendar date ("YYYY-MM-DD") as a date-only value, or null. */
export function optionalDate(o: Record<string, unknown>, key: string): Date | null {
  const v = o[key];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const date = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== v ? null : date;
}

// JSON Schema fragments. Every object lists all its properties as required and allows no others,
// which is what the model service asks of a schema.
export const S = {
  string: { type: 'string' },
  boolean: { type: 'boolean' },
  strings: { type: 'array', items: { type: 'string' } },
  nullableString: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  nullableNumber: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  nullableDate: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
  oneOf: (values: readonly string[]) => ({ type: 'string', enum: [...values] }),
  object: (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false }),
  list: (items: unknown) => ({ type: 'array', items }),
} as const;
