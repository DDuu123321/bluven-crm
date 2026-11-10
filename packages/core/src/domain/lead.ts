// Validation of an incoming lead. The rules mirror the Bluven lead API so that Bluven can forward
// its lead objects unchanged. See docs/bluven-lead-forwarding-spec.md.
import { normalizeEmail, normalizePhone } from './normalize';

export const AU_STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'] as const;
export const PROPERTY_TYPES = ['House', 'Townhouse / Unit', 'Commercial'] as const;
export const COMPONENTS = ['Solar', 'Battery', 'EV', 'Heat pump'] as const;
export const TIMELINES = ['asap', '1-month', '1-3-months', 'researching'] as const;
export const BEST_TIMES = ['anytime', 'morning', 'afternoon', 'evening', 'email-only', 'weekend'] as const;

export const TIMELINE_LABEL: Record<(typeof TIMELINES)[number], string> = {
  asap: 'As soon as possible',
  '1-month': 'Within 1 month',
  '1-3-months': '1 to 3 months',
  researching: 'Just researching',
};

export const BEST_TIME_LABEL: Record<(typeof BEST_TIMES)[number], string> = {
  anytime: 'Anytime',
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  'email-only': 'Email only',
  weekend: 'Weekend',
};

export const ATTRIBUTION_KEYS = [
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmContent',
  'utmTerm',
  'landingPage',
  'referrer',
] as const;

export interface LeadInput {
  externalId?: string;
  createdAt?: Date;
  sourceDetail?: string;
  attribution?: Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>>;

  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
  address?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  propertyType?: string;
  components?: string[];
  systemKw?: number;
  batteryKwh?: number;
  monthlyBill?: number;
  timeline?: string;
  bestTime?: string;
  notes?: string;
  householdSize?: string;
  goals?: string;
  productPreference?: string;
}

/** The enquiry details kept on the order (everything that is not identity or address). */
export type LeadDetails = Pick<
  LeadInput,
  | 'components'
  | 'systemKw'
  | 'batteryKwh'
  | 'monthlyBill'
  | 'timeline'
  | 'bestTime'
  | 'notes'
  | 'householdSize'
  | 'goals'
  | 'productPreference'
>;

export function leadDetailsOf(lead: LeadInput): LeadDetails {
  const d: LeadDetails = {};
  if (lead.components?.length) d.components = lead.components;
  if (lead.systemKw !== undefined) d.systemKw = lead.systemKw;
  if (lead.batteryKwh !== undefined) d.batteryKwh = lead.batteryKwh;
  if (lead.monthlyBill !== undefined) d.monthlyBill = lead.monthlyBill;
  if (lead.timeline) d.timeline = lead.timeline;
  if (lead.bestTime) d.bestTime = lead.bestTime;
  if (lead.notes) d.notes = lead.notes;
  if (lead.householdSize) d.householdSize = lead.householdSize;
  if (lead.goals) d.goals = lead.goals;
  if (lead.productPreference) d.productPreference = lead.productPreference;
  return d;
}

export type ParseLeadResult = { ok: true; lead: LeadInput } | { ok: false; error: string };

export interface ParseLeadOptions {
  /** API callers must send an externalId so that retries are idempotent. */
  requireExternalId: boolean;
  /** Reference time for the "not in the future" check on createdAt. */
  now?: Date;
}

class LeadError extends Error {}
const fail = (field: string, reason: string): never => {
  throw new LeadError(`${field}: ${reason}`);
};

/** Omitted, null and empty-string values all mean "not provided". */
function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function optString(obj: Record<string, unknown>, field: string, max: number): string | undefined {
  const v = obj[field];
  if (isBlank(v)) return undefined;
  if (typeof v !== 'string') return fail(field, 'must be a string');
  const s = v.trim();
  if (s.length > max) return fail(field, `must be at most ${max} characters`);
  return s;
}

function optEnum(obj: Record<string, unknown>, field: string, allowed: readonly string[]): string | undefined {
  const v = obj[field];
  if (isBlank(v)) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v)) return fail(field, `must be one of ${allowed.join(', ')}`);
  return v;
}

function optNumber(obj: Record<string, unknown>, field: string): number | undefined {
  const v = obj[field];
  if (isBlank(v)) return undefined;
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
  else return fail(field, 'must be a number');
  if (!Number.isFinite(n) || n < 0) return fail(field, 'must be a number that is zero or greater');
  if (n > 1_000_000) return fail(field, 'is too large');
  return n;
}

/** Accepts a string or an array of strings and joins arrays with ", ". */
function optTextOrList(obj: Record<string, unknown>, fields: string[], max: number): string | undefined {
  for (const field of fields) {
    const v = obj[field];
    if (isBlank(v)) continue;
    let s: string;
    if (typeof v === 'string') s = v.trim();
    else if (typeof v === 'number') s = String(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      s = v.map((x) => String(x).trim()).filter(Boolean).join(', ');
    } else return fail(fields[0]!, 'must be a string or a list of strings');
    if (s.length > max) return fail(fields[0]!, `must be at most ${max} characters`);
    if (s) return s;
  }
  return undefined;
}

/** Validates one raw lead object. Unknown fields are ignored. */
export function parseLead(raw: unknown, opts: ParseLeadOptions): ParseLeadResult {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new LeadError('lead: must be an object');
    }
    const o = raw as Record<string, unknown>;
    const lead: LeadInput = { firstName: '', phone: '' };

    // ---- identity
    const firstName = optString(o, 'firstName', 100);
    if (!firstName) return fail('firstName', 'is required');
    lead.firstName = firstName;
    const lastName = optString(o, 'lastName', 100);
    if (lastName) lead.lastName = lastName;

    const phoneRaw = o.phone;
    if (isBlank(phoneRaw)) return fail('phone', 'is required');
    if (typeof phoneRaw !== 'string' && typeof phoneRaw !== 'number') {
      return fail('phone', 'Please enter a valid phone number.');
    }
    const phone = String(phoneRaw).trim();
    if (!normalizePhone(phone).valid) return fail('phone', 'Please enter a valid phone number.');
    lead.phone = phone;

    const emailRaw = optString(o, 'email', 254);
    if (emailRaw) {
      const email = normalizeEmail(emailRaw);
      if (!email) return fail('email', 'Please enter a valid email address.');
      lead.email = email;
    }

    // ---- address
    const address = optString(o, 'address', 200);
    if (address) lead.address = address;
    const suburb = optString(o, 'suburb', 100);
    if (suburb) lead.suburb = suburb;
    const state = optEnum(o, 'state', AU_STATES);
    if (state) lead.state = state;
    if (!isBlank(o.postcode)) {
      const pc = typeof o.postcode === 'number' ? String(o.postcode).padStart(4, '0') : o.postcode;
      if (typeof pc !== 'string' || !/^\d{4}$/.test(pc.trim())) return fail('postcode', 'must be 4 digits');
      lead.postcode = pc.trim();
    }
    const propertyType = optEnum(o, 'propertyType', PROPERTY_TYPES);
    if (propertyType) lead.propertyType = propertyType;

    // ---- enquiry
    if (!isBlank(o.components)) {
      const list = typeof o.components === 'string' ? [o.components] : o.components;
      if (!Array.isArray(list) || !list.every((c) => typeof c === 'string' && (COMPONENTS as readonly string[]).includes(c))) {
        return fail('components', `must be one or more of ${COMPONENTS.join(', ')}`);
      }
      const unique = [...new Set(list as string[])];
      if (unique.length) lead.components = unique;
    }
    const systemKw = optNumber(o, 'systemKw');
    if (systemKw !== undefined) lead.systemKw = systemKw;
    const batteryKwh = optNumber(o, 'batteryKwh');
    if (batteryKwh !== undefined) lead.batteryKwh = batteryKwh;
    const monthlyBill = optNumber(o, 'monthlyBill');
    if (monthlyBill !== undefined) lead.monthlyBill = monthlyBill;
    const timeline = optEnum(o, 'timeline', TIMELINES);
    if (timeline) lead.timeline = timeline;
    const bestTime = optEnum(o, 'bestTime', BEST_TIMES);
    if (bestTime) lead.bestTime = bestTime;
    const notes = optString(o, 'notes', 5000);
    if (notes) lead.notes = notes;
    const householdSize = optTextOrList(o, ['householdSize', 'household_size'], 100);
    if (householdSize) lead.householdSize = householdSize;
    const goals = optTextOrList(o, ['goals'], 1000);
    if (goals) lead.goals = goals;
    const productPreference = optTextOrList(o, ['productPreference', 'product_preference'], 1000);
    if (productPreference) lead.productPreference = productPreference;

    // ---- CRM additions
    if (!isBlank(o.externalId)) {
      if (typeof o.externalId !== 'string' && typeof o.externalId !== 'number') {
        return fail('externalId', 'must be a string or a number');
      }
      const externalId = String(o.externalId).trim();
      if (externalId.length > 64) return fail('externalId', 'must be at most 64 characters');
      lead.externalId = externalId;
    } else if (opts.requireExternalId) {
      return fail('externalId', 'is required');
    }

    if (!isBlank(o.createdAt)) {
      const v = o.createdAt;
      const hasZone = typeof v === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/.test(v.trim());
      const date = typeof v === 'string' ? new Date(v.trim()) : new Date(NaN);
      if (!hasZone || Number.isNaN(date.getTime())) {
        return fail('createdAt', 'must be an ISO 8601 date-time with a time zone, e.g. 2026-11-09T10:21:00+11:00');
      }
      const now = opts.now ?? new Date();
      if (date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return fail('createdAt', 'must not be in the future');
      lead.createdAt = date;
    }

    // Marketing metadata is trimmed rather than rejected: a long referrer must never cost us a lead.
    if (!isBlank(o.sourceDetail)) {
      if (typeof o.sourceDetail !== 'string') return fail('sourceDetail', 'must be a string');
      lead.sourceDetail = o.sourceDetail.trim().slice(0, 100);
    }
    if (!isBlank(o.attribution)) {
      const a = o.attribution;
      if (typeof a !== 'object' || a === null || Array.isArray(a)) return fail('attribution', 'must be an object');
      const out: NonNullable<LeadInput['attribution']> = {};
      for (const key of ATTRIBUTION_KEYS) {
        const v = (a as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 500);
      }
      if (Object.keys(out).length) lead.attribution = out;
    }

    return { ok: true, lead };
  } catch (e) {
    if (e instanceof LeadError) return { ok: false, error: e.message };
    throw e;
  }
}
