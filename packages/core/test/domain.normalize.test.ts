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

describe('numbers and addresses as people really write them', () => {
  it('recognises more spellings of the same Australian number', () => {
    const same = '+61291234567';
    expect(normalizePhone('02 9123 4567').normalized).toBe(same);
    expect(normalizePhone('2 9123 4567').normalized).toBe(same); // a spreadsheet dropped the zero
    expect(normalizePhone('0061 2 9123 4567').normalized).toBe(same);
    expect(normalizePhone('0061 412 345 678').normalized).toBe('+61412345678');
    expect(normalizePhone('412345678').normalized).toBe('+61412345678');
  });

  it('uses the state to complete a local landline, so equal digits in two cities are two numbers', () => {
    expect(normalizePhone('9123 4567', { state: 'NSW' }).normalized).toBe('+61291234567');
    expect(normalizePhone('9123 4567', { state: 'VIC' }).normalized).toBe('+61391234567');
    expect(normalizePhone('9123 4567', { state: 'qld' }).normalized).toBe('+61791234567');
    // Matches the same number written in full.
    expect(normalizePhone('9123 4567', { state: 'ACT' }).normalized).toBe(normalizePhone('(02) 9123 4567').normalized);
    // Without a state it stays as typed, and a full number is never changed by the hint.
    expect(normalizePhone('9123 4567').normalized).toBe('91234567');
    expect(normalizePhone('0412 345 678', { state: 'VIC' }).normalized).toBe('+61412345678');
  });

  it('treats common variants of one street address as the same', () => {
    const base = normalizeAddressLine('3/12 Sample St');
    expect(normalizeAddressLine('12 Sample St Unit 3')).toBe(base);
    expect(normalizeAddressLine('12 Sample Street, Apt 3')).toBe(base);
    expect(normalizeAddressLine("14 O'Connell Tce")).toBe(normalizeAddressLine('14 OConnell Terrace'));
    expect(normalizeAddressLine('14 Oconnell Ter')).toBe(normalizeAddressLine('14 O’Connell Tce'));
    expect(normalizeAddressLine('12–14 Sample Crct')).toBe(normalizeAddressLine('12-14 Sample Circuit'));
    // Different addresses stay different.
    expect(normalizeAddressLine('12 Sample St Unit 3')).not.toBe(normalizeAddressLine('12 Sample St Unit 4'));
    expect(normalizeAddressLine('3/12 Sample St')).not.toBe(normalizeAddressLine('12 Sample St'));
  });

  it('copes with the whole address typed into the street field', () => {
    const tidy = { line1: '12 Sample St', suburb: 'Parramatta', postcode: '2150' };
    const full = { line1: '12 Sample St, Parramatta NSW 2150', suburb: 'Parramatta', postcode: '2150' };
    const noState = { line1: '12 Sample Street Parramatta 2150', suburb: 'Parramatta', postcode: '2150' };
    expect(addressKey(full)).toBe(addressKey(tidy));
    expect(addressKey(noState)).toBe(addressKey(tidy));
    expect(sameCustomerProperty(full, tidy)).toBe(true);
    // A street that merely contains the suburb's name is left alone.
    const named = { line1: '5 Parramatta Rd', suburb: 'Parramatta', postcode: '2150' };
    expect(addressKey(named)).toBe('5 parramatta rd|parramatta|2150');
    expect(addressKey({ line1: '5 Parramatta', suburb: 'Parramatta', postcode: '2150' })).toBe('5 parramatta|parramatta|2150');
    // Suburbs with apostrophes compare equal either way.
    expect(addressKey({ line1: '1 High St', suburb: "O'Connor", postcode: '2602' })).toBe(addressKey({ line1: '1 High St', suburb: 'OConnor', postcode: '2602' }));
  });
});
