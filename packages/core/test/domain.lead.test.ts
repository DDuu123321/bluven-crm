import { describe, expect, it } from 'vitest';
import { leadDetailsOf, parseLead } from '../src/domain';

const api = { requireExternalId: true, now: new Date('2026-11-10T00:00:00Z') };
const full = {
  externalId: '1042',
  createdAt: '2026-11-09T10:21:00+11:00',
  sourceDetail: 'website/quote-form',
  attribution: { utmSource: 'google', utmMedium: 'cpc', unknownKey: 'ignored' },
  firstName: 'Jane',
  lastName: 'Smith',
  phone: '0412 345 678',
  email: 'Jane@Example.com',
  address: '12 Sample St',
  suburb: 'Parramatta',
  state: 'NSW',
  postcode: '2150',
  propertyType: 'House',
  components: ['Solar', 'Battery'],
  systemKw: 6.6,
  batteryKwh: 10,
  monthlyBill: 350,
  timeline: '1-month',
  bestTime: 'afternoon',
  notes: 'Referred from our website enquiry form.',
  householdSize: '4',
  goals: ['Lower my bills', 'Backup during blackouts'],
  productPreference: 'Tesla Powerwall 3',
  somethingElse: 'ignored',
};

function error(raw: unknown, opts = api): string {
  const r = parseLead(raw, opts);
  if (r.ok) throw new Error('expected a validation error');
  return r.error;
}

describe('parseLead', () => {
  it('accepts the documented example', () => {
    const r = parseLead(full, api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead).toMatchObject({
      externalId: '1042',
      firstName: 'Jane',
      lastName: 'Smith',
      phone: '0412 345 678',
      email: 'jane@example.com',
      state: 'NSW',
      postcode: '2150',
      components: ['Solar', 'Battery'],
      systemKw: 6.6,
      goals: 'Lower my bills, Backup during blackouts',
      sourceDetail: 'website/quote-form',
      attribution: { utmSource: 'google', utmMedium: 'cpc' },
    });
    expect(r.lead.createdAt?.toISOString()).toBe('2026-11-08T23:21:00.000Z');
    expect(r.lead).not.toHaveProperty('somethingElse');
  });

  it('needs only firstName, phone and (for the API) externalId', () => {
    expect(parseLead({ firstName: 'Jo', phone: '0412345678', externalId: 7 }, api)).toEqual({
      ok: true,
      lead: { firstName: 'Jo', phone: '0412345678', externalId: '7' },
    });
    expect(error({ firstName: 'Jo', phone: '0412345678' })).toBe('externalId: is required');
    expect(parseLead({ firstName: 'Jo', phone: '0412345678' }, { requireExternalId: false }).ok).toBe(true);
  });

  it('treats null and empty strings as not provided', () => {
    const r = parseLead({ firstName: 'Jo', phone: '0412345678', externalId: 'a', email: '', lastName: null, state: '', components: null }, api);
    expect(r).toEqual({ ok: true, lead: { firstName: 'Jo', phone: '0412345678', externalId: 'a' } });
  });

  it('reports the field and the reason', () => {
    expect(error({ ...full, firstName: '' })).toBe('firstName: is required');
    expect(error({ ...full, phone: undefined })).toBe('phone: is required');
    expect(error({ ...full, phone: '12345' })).toBe('phone: Please enter a valid phone number.');
    expect(error({ ...full, email: 'not-an-email' })).toBe('email: Please enter a valid email address.');
    expect(error({ ...full, state: 'nsw' })).toBe('state: must be one of NSW, VIC, QLD, SA, WA, TAS, ACT, NT');
    expect(error({ ...full, postcode: '215' })).toBe('postcode: must be 4 digits');
    expect(error({ ...full, propertyType: 'house' })).toMatch(/^propertyType: must be one of/);
    expect(error({ ...full, components: ['Solar', 'Wind'] })).toMatch(/^components: must be one or more of/);
    expect(error({ ...full, systemKw: 'big' })).toBe('systemKw: must be a number');
    expect(error({ ...full, monthlyBill: -5 })).toMatch(/^monthlyBill: /);
    expect(error({ ...full, timeline: 'soon' })).toMatch(/^timeline: must be one of/);
    expect(error({ ...full, bestTime: 'noon' })).toMatch(/^bestTime: must be one of/);
    expect(error({ ...full, notes: 'x'.repeat(5001) })).toBe('notes: must be at most 5000 characters');
    expect(error({ ...full, externalId: 'x'.repeat(65) })).toBe('externalId: must be at most 64 characters');
    expect(error('nope')).toBe('lead: must be an object');
  });

  it('is lenient where the Bluven API is', () => {
    const r = parseLead({ ...full, components: 'Solar', systemKw: '6.6', household_size: 4, product_preference: ['Tesla', 'BYD'], householdSize: undefined, productPreference: undefined, postcode: 800 }, api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.components).toEqual(['Solar']);
    expect(r.lead.systemKw).toBe(6.6);
    expect(r.lead.householdSize).toBe('4');
    expect(r.lead.productPreference).toBe('Tesla, BYD');
    expect(r.lead.postcode).toBe('0800');
  });

  it('requires a time zone on createdAt and rejects future dates', () => {
    expect(error({ ...full, createdAt: '2026-11-09T10:21:00' })).toMatch(/^createdAt: must be an ISO 8601/);
    expect(error({ ...full, createdAt: 'yesterday' })).toMatch(/^createdAt: /);
    expect(error({ ...full, createdAt: '2027-01-01T00:00:00Z' })).toBe('createdAt: must not be in the future');
    expect(parseLead({ ...full, createdAt: '2026-11-09T10:21:00Z' }, api).ok).toBe(true);
  });

  it('trims marketing metadata instead of rejecting the lead', () => {
    const r = parseLead({ ...full, sourceDetail: 's'.repeat(300), attribution: { referrer: 'r'.repeat(900) } }, api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.sourceDetail).toHaveLength(100);
    expect(r.lead.attribution?.referrer).toHaveLength(500);
  });

  it('extracts the enquiry details kept on the order', () => {
    const r = parseLead(full, api);
    if (!r.ok) throw new Error('unexpected');
    expect(leadDetailsOf(r.lead)).toEqual({
      components: ['Solar', 'Battery'],
      systemKw: 6.6,
      batteryKwh: 10,
      monthlyBill: 350,
      timeline: '1-month',
      bestTime: 'afternoon',
      notes: 'Referred from our website enquiry form.',
      householdSize: '4',
      goals: 'Lower my bills, Backup during blackouts',
      productPreference: 'Tesla Powerwall 3',
    });
  });
});
