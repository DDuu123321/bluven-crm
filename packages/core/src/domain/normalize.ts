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
 *   0061 412 345 678  -> +61412345678
 *   2 9123 4567       -> +61291234567    (leading zero lost, as spreadsheets do)
 *   9123 4567         -> +61291234567 when the state is known to be NSW or ACT,
 *                        91234567 otherwise (local number without area code: kept as digits)
 */
const AREA_CODE: Record<string, string> = { NSW: '2', ACT: '2', VIC: '3', TAS: '3', QLD: '7', SA: '8', WA: '8', NT: '8' };

export function normalizePhone(raw: string, hint: { state?: string | null } = {}): NormalizedPhone {
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
  } else if (digits.startsWith('0061') && digits.length === 13) {
    // Written with "00" for the plus.
    normalized = '+' + digits.slice(2);
  } else if (digits.startsWith('61') && digits.length === 11) {
    normalized = '+' + digits;
  } else if (digits.startsWith('0') && digits.length === 10) {
    normalized = '+61' + digits.slice(1);
  } else if (/^[23478]/.test(digits) && digits.length === 9) {
    // Mobile or area-coded landline written without the leading zero.
    normalized = '+61' + digits;
  } else if (digits.length === 8 && hint.state && AREA_CODE[hint.state.toUpperCase()]) {
    // A local landline: the state the enquiry came from tells us the area code. Without this
    // "9123 4567" in Sydney and in Melbourne would count as the same number.
    normalized = '+61' + AREA_CODE[hint.state.toUpperCase()] + digits;
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
  ter: 'tce',
  boulevard: 'blvd',
  bvd: 'blvd',
  close: 'cl',
  circuit: 'cct',
  cir: 'cct',
  crct: 'cct',
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

const UNIT_WORDS = '(?:unit|u|apt|apartment|flat|villa|townhouse|th|shop|suite|ste|lot)';
const UNIT_PREFIX = new RegExp(`^${UNIT_WORDS}\\s*\\.?\\s*([0-9]+[a-z]?)\\s*[,/\\-\\s]\\s*(\\d.*)$`);
/** "12 Sample St, Unit 3": the unit after the street. */
const UNIT_SUFFIX = new RegExp(`^(\\d.*?)[\\s,]+${UNIT_WORDS}\\s*\\.?\\s*([0-9]+[a-z]?)$`);

/**
 * Normalises a street address line so that common spellings of the same address compare equal:
 * "Unit 3, 12 Sample Street", "U3/12 Sample St." and "3 / 12 sample st" all become "3/12 sample st".
 */
export function normalizeAddressLine(line: string): string {
  // Apostrophes vanish ("O'Connell" is "OConnell"); other punctuation becomes a space; any kind of
  // dash is a plain hyphen ("12–14" is "12-14").
  let s = line
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[."#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const unit = UNIT_PREFIX.exec(s);
  const unitAfter = unit ? null : UNIT_SUFFIX.exec(s);
  if (unit) s = `${unit[1]}/${unit[2]}`;
  else if (unitAfter) s = `${unitAfter[2]}/${unitAfter[1]}`;
  s = s.replace(/\s*\/\s*/g, '/').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return s
    .split(' ')
    .map((word) => STREET_WORDS[word] ?? word)
    .join(' ');
}

function normalizeSuburb(suburb: string): string {
  return suburb
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[.,]/g, ' ')
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
  const suburb = normalizeSuburb(a.suburb);
  const postcode = a.postcode.replace(/\D/g, '');
  const line1 = streetOnly(normalizeAddressLine(a.line1), suburb, postcode);
  if (!line1 || !suburb || !postcode) return null;
  return `${line1}|${suburb}|${postcode}`;
}

const STATE_WORDS = '(?:nsw|vic|qld|sa|wa|tas|act|nt)';

/**
 * People often type the whole address into the street field ("12 Sample St, Parramatta NSW 2150")
 * and fill suburb and postcode as well. The repeated tail is dropped so both spellings compare equal.
 */
function streetOnly(line: string, suburb: string, postcode: string): string {
  if (!line || !suburb) return line;
  const escaped = suburb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = new RegExp(`\\s+${escaped}(?:\\s+${STATE_WORDS})?(?:\\s+${postcode || '\\d{4}'})?$`);
  const stripped = line.replace(tail, '').trim();
  // Keep the line when stripping would leave no street at all (a street named like its suburb).
  return /\d/.test(stripped) && stripped.includes(' ') ? stripped : line;
}

/**
 * Whether two addresses of the SAME customer refer to the same property. Uses the full key when
 * both sides have one, and falls back to the street line when either side is incomplete.
 */
export function sameCustomerProperty(a: AddressParts, b: AddressParts): boolean {
  const street = (x: AddressParts) => streetOnly(normalizeAddressLine(x.line1), normalizeSuburb(x.suburb), x.postcode.replace(/\D/g, ''));
  const lineA = street(a);
  const lineB = street(b);
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
