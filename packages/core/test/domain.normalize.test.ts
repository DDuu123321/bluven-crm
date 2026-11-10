import { describe, expect, it } from 'vitest';
import {
  addressKey,
  formatAddress,
  normalizeAddressLine,
  normalizeEmail,
  normalizePhone,
  sameCustomerProperty,
} from '../src/domain';

describe('normalizeEmail', () => {
  it('lower-cases and trims', () => {
    expect(normalizeEmail('  Jane.Smith@Example.COM ')).toBe('jane.smith@example.com');
  });
  it('rejects things that are not email addresses', () => {
    for (const bad of ['', 'jane', 'jane@', '@example.com', 'jane@example', 'jane smith@example.com', 'a@b@c.com']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe('normalizePhone', () => {
  it('brings Australian mobile spellings to one form', () => {
    const variants = ['0412 345 678', '0412-345-678', '+61 412 345 678', '+61 (0)412 345 678', '61412345678', '412345678', '(0412) 345 678'];
    for (const v of variants) expect(normalizePhone(v).normalized).toBe('+61412345678');
  });
  it('handles landlines with an area code', () => {
    expect(normalizePhone('(03) 9123 4567').normalized).toBe('+61391234567');
    expect(normalizePhone('+61 3 9123 4567').normalized).toBe('+61391234567');
  });
  it('keeps local numbers without an area code as digits', () => {
    const p = normalizePhone('9123 4567');
    expect(p.normalized).toBe('91234567');
    expect(p.valid).toBe(true);
  });
  it('keeps other international numbers in E.164', () => {
    expect(normalizePhone('+64 21 123 4567').normalized).toBe('+64211234567');
    expect(normalizePhone('0011 64 21 123 4567').normalized).toBe('+64211234567');
  });
  it('validates 8 to 15 digits and the allowed characters', () => {
    expect(normalizePhone('1234567').valid).toBe(false);
    expect(normalizePhone('1234567890123456').valid).toBe(false);
    expect(normalizePhone('0412 345 678 ext 5').valid).toBe(false);
    expect(normalizePhone('call me').valid).toBe(false);
    expect(normalizePhone('0412 345 678').valid).toBe(true);
  });
});

describe('address normalisation', () => {
  it('treats common spellings of the same street address as equal', () => {
    const expected = '12 sample st';
    for (const v of ['12 Sample St', '12 Sample Street', '12  sample st.', '12 SAMPLE STREET']) {
      expect(normalizeAddressLine(v)).toBe(expected);
    }
  });
  it('unifies unit notations', () => {
    for (const v of ['Unit 3, 12 Sample Street', 'U3/12 Sample St', '3/12 Sample St', '3 / 12 sample st', 'Apt 3 12 Sample Street', 'unit 3/12 Sample St']) {
      expect(normalizeAddressLine(v)).toBe('3/12 sample st');
    }
  });
  it('does not confuse different units or numbers', () => {
    expect(normalizeAddressLine('3/12 Sample St')).not.toBe(normalizeAddressLine('4/12 Sample St'));
    expect(normalizeAddressLine('12 Sample St')).not.toBe(normalizeAddressLine('3/12 Sample St'));
    expect(normalizeAddressLine('12 Sample St')).not.toBe(normalizeAddressLine('12 Sample Rd'));
    expect(normalizeAddressLine('12A Sample St')).not.toBe(normalizeAddressLine('12 Sample St'));
  });
  it('builds a full key only from a complete address', () => {
    expect(addressKey({ line1: '12 Sample Street', suburb: 'Parramatta', postcode: '2150' })).toBe('12 sample st|parramatta|2150');
    expect(addressKey({ line1: '12 Sample Street', suburb: '', postcode: '2150' })).toBeNull();
    expect(addressKey({ line1: '12 Sample Street', suburb: 'Parramatta', postcode: '' })).toBeNull();
    expect(addressKey({ line1: '', suburb: 'Parramatta', postcode: '2150' })).toBeNull();
    expect(addressKey({ line1: '5 Hill Rd', suburb: 'Mount Druitt', postcode: '2770' })).toBe(
      addressKey({ line1: '5 Hill Road', suburb: 'Mt Druitt', postcode: '2770' }),
    );
  });
  it('separates the same street address in different suburbs', () => {
    expect(addressKey({ line1: '12 Station St', suburb: 'Parramatta', postcode: '2150' })).not.toBe(
      addressKey({ line1: '12 Station St', suburb: 'Harris Park', postcode: '2150' }),
    );
  });
  it('matches properties of one customer, falling back to the street line when incomplete', () => {
    const full = { line1: '12 Sample St', suburb: 'Parramatta', postcode: '2150' };
    expect(sameCustomerProperty(full, { line1: '12 Sample Street', suburb: 'parramatta', postcode: '2150' })).toBe(true);
    expect(sameCustomerProperty(full, { line1: '12 Sample Street', suburb: '', postcode: '' })).toBe(true);
    expect(sameCustomerProperty(full, { line1: '12 Sample Street', suburb: 'Ryde', postcode: '2112' })).toBe(false);
    expect(sameCustomerProperty(full, { line1: '14 Sample Street', suburb: '', postcode: '' })).toBe(false);
    expect(sameCustomerProperty(full, { line1: '', suburb: 'Parramatta', postcode: '2150' })).toBe(false);
  });
  it('formats an address on one line', () => {
    expect(formatAddress({ addressLine1: '12 Sample St', suburb: 'Parramatta', state: 'NSW', postcode: '2150' })).toBe(
      '12 Sample St, Parramatta NSW 2150',
    );
    expect(formatAddress({ addressLine1: '', suburb: '', state: '', postcode: '' })).toBe('');
  });
});
