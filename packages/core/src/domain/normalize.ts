// Normalisation used for duplicate detection. Pure functions, safe for browser code.

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:".]{2,}$/;

/** Lower-cases and trims. Returns null when the value is not a plausible email address. */
export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  return EMAIL_RE.test(email) ? email : null;
}

export interface NormalizedPhone {
  /** Canonical form for matching: E.164 for recognisable Australian and international numbers, digits otherwise. */
  normalized: string;
  /** Number of digits as entered. */
  digitCount: number;
  /** 8 to 15 digits and no characters other than digits, spaces, dashes, dots, brackets and a leading plus. */
  valid: boolean;
}

/**
 * Normalises a phone number with Australian conventions:
 *   0412 345 678      -> +61412345678
 *   +61 412 345 678   -> +61412345678
 *   +61 (0)412 345 678-> +61412345678
 *   61412345678       -> +61412345678
 *   (03) 9123 4567    -> +61391234567
 *   0011 64 21 123456 -> +6421123456
 *   9123 4567         -> 91234567        (local number without area code: kept as digits)
 */
export function normalizePhone(raw: string): NormalizedPhone {
  const trimmed = raw.trim();
  const allowed = /^\+?[\d\s\-().]+$/.test(trimmed);
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  const digitCount = digits.length;
  const valid = allowed && digitCount >= 8 && digitCount <= 15;

  let normalized: string;
  if (hasPlus) {
    // "+61 (0)412..." is a common way to write Australian numbers.
    if (digits.startsWith('610') && digits.length === 12) digits = '61' + digits.slice(3);
    normalized = '+' + digits;
  } else if (digits.startsWith('0011') && digits.length > 8) {
    normalized = '+' + digits.slice(4);
  } else if (digits.startsWith('61') && digits.length === 11) {
    normalized = '+' + digits;
  } else if (digits.startsWith('0') && digits.length === 10) {
    normalized = '+61' + digits.slice(1);
  } else if (digits.startsWith('4') && digits.length === 9) {
    // Mobile number written without the leading zero.
    normalized = '+61' + digits;
  } else {
    normalized = digits;
  }
  return { normalized, digitCount, valid };
}

const STREET_WORDS: Record<string, string> = {
  street: 'st',
  str: 'st',
  road: 'rd',
  avenue: 'ave',
  av: 'ave',
  drive: 'dr',
  drv: 'dr',
  court: 'ct',
  crt: 'ct',
  place: 'pl',
  crescent: 'cres',
  cr: 'cres',
  cresent: 'cres',
  parade: 'pde',
  highway: 'hwy',
  lane: 'ln',
  la: 'ln',
  terrace: 'tce',
  boulevard: 'blvd',
  bvd: 'blvd',
  close: 'cl',
  circuit: 'cct',
  cir: 'cct',
  grove: 'gr',
  gve: 'gr',
  square: 'sq',
  esplanade: 'esp',
  promenade: 'prom',
  mount: 'mt',
  saint: 'st',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
};

const UNIT_PREFIX =
  /^(?:unit|u|apt|apartment|flat|villa|townhouse|th|shop|suite|ste|lot)\s*\.?\s*([0-9]+[a-z]?)\s*[,/\-\s]\s*(\d.*)$/;

/**
 * Normalises a street address line so that common spellings of the same address compare equal:
 * "Unit 3, 12 Sample Street", "U3/12 Sample St." and "3 / 12 sample st" all become "3/12 sample st".
 */
export function normalizeAddressLine(line: string): string {
  let s = line.toLowerCase().replace(/[.'’"#]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const unit = UNIT_PREFIX.exec(s);
  if (unit) s = `${unit[1]}/${unit[2]}`;
  s = s.replace(/\s*\/\s*/g, '/').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return s
    .split(' ')
    .map((word) => STREET_WORDS[word] ?? word)
    .join(' ');
}

function normalizeSuburb(suburb: string): string {
  return suburb
    .toLowerCase()
    .replace(/[.'’,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (word === 'mount' ? 'mt' : word === 'saint' ? 'st' : word))
    .join(' ');
}

export interface AddressParts {
  line1: string;
  suburb: string;
  postcode: string;
}

/**
 * Full duplicate-detection key "line1|suburb|postcode".
 * Null unless the street line, suburb and postcode are all present: a partial address is too weak
 * to match across different customers.
 */
export function addressKey(a: AddressParts): string | null {
  const line1 = normalizeAddressLine(a.line1);
  const suburb = normalizeSuburb(a.suburb);
  const postcode = a.postcode.replace(/\D/g, '');
  if (!line1 || !suburb || !postcode) return null;
  return `${line1}|${suburb}|${postcode}`;
}

/**
 * Whether two addresses of the SAME customer refer to the same property. Uses the full key when
 * both sides have one, and falls back to the street line when either side is incomplete.
 */
export function sameCustomerProperty(a: AddressParts, b: AddressParts): boolean {
  const lineA = normalizeAddressLine(a.line1);
  const lineB = normalizeAddressLine(b.line1);
  if (!lineA || !lineB) return false;
  const keyA = addressKey(a);
  const keyB = addressKey(b);
  if (keyA && keyB) return keyA === keyB;
  return lineA === lineB;
}

/** One-line display form of an address. */
export function formatAddress(a: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
}): string {
  const street = [a.addressLine1, a.addressLine2].map((s) => (s ?? '').trim()).filter(Boolean).join(', ');
  const locality = [a.suburb, a.state, a.postcode].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  return [street, locality].filter(Boolean).join(', ');
}
