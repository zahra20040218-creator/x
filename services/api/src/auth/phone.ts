/**
 * Iraqi phone numbers. CLAUDE.md §8:
 *
 *   storage: E.164, +964XXXXXXXXX
 *   input:   accept 07XXXXXXXXX and normalise server-side
 *
 * Getting this wrong does not throw - it creates a SECOND account for the same
 * human. They sign up as 07700000001, come back later and type +9647700000001,
 * and their ride history is gone. So normalisation is centralised, total, and
 * tested against every form a person might actually type, including the ones
 * with spaces and dashes that a phone keypad produces.
 */

export class InvalidPhoneNumberError extends Error {
  constructor(readonly input: string) {
    super(`Not a valid Iraqi mobile number: ${input}`);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Iraqi mobile prefixes in national form, after the leading 0.
 *
 *   75, 77, 78, 79  Asiacell / Zain / Korek and their sub-ranges
 *   74              newer allocations
 *
 * Landlines are deliberately not accepted: an OTP has to arrive by SMS.
 */
const MOBILE_PREFIXES = ['74', '75', '77', '78', '79'];

const NATIONAL_LENGTH = 10; // 7XXXXXXXXX, i.e. without the leading 0
const E164 = /^\+964(7[45789]\d{8})$/;

/**
 * Normalise any accepted input form to E.164.
 *
 * Accepted:
 *   07700000001        national with trunk prefix
 *   7700000001         national without trunk prefix
 *   +9647700000001     E.164
 *   009647700000001    international access code
 *   9647700000001      country code, no plus
 *   with spaces, dashes, parentheses or non-breaking spaces anywhere
 *   with Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩), which Arabic keyboards produce
 *
 * @throws InvalidPhoneNumberError for anything else.
 */
export function normalizeIraqiPhone(input: string): string {
  if (typeof input !== 'string') throw new InvalidPhoneNumberError(String(input));

  // Strip separators, plus the invisible directional marks (U+200E/U+200F) and
  // the non-breaking space (U+00A0) that Arabic-locale keyboards and RTL text
  // editors insert around Latin digits. Written as escapes rather than literal
  // characters so the intent survives copy/paste and code review.
  let digits = toWesternDigits(input).replace(/[\s()\-.\u00A0\u200E\u200F]/g, '');

  const hadPlus = digits.startsWith('+');
  if (hadPlus) digits = digits.slice(1);

  if (!/^\d+$/.test(digits)) throw new InvalidPhoneNumberError(input);

  // 00964... -> 964...
  if (digits.startsWith('00964')) digits = digits.slice(2);

  // 964... -> national
  if (digits.startsWith('964')) {
    digits = digits.slice(3);
    // A number written +9640770... has a redundant trunk prefix. Tolerate it:
    // people do type it, and rejecting it creates a support ticket, not safety.
    if (digits.startsWith('0')) digits = digits.slice(1);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1);
  } else if (hadPlus) {
    // A plus that was not followed by 964 is some other country.
    throw new InvalidPhoneNumberError(input);
  }

  if (digits.length !== NATIONAL_LENGTH) throw new InvalidPhoneNumberError(input);

  const prefix = digits.slice(0, 2);
  if (!MOBILE_PREFIXES.includes(prefix)) throw new InvalidPhoneNumberError(input);

  const e164 = `+964${digits}`;
  if (!E164.test(e164)) throw new InvalidPhoneNumberError(input);

  return e164;
}

/** Non-throwing form, for validating untrusted input at a boundary. */
export function tryNormalizeIraqiPhone(input: string): string | null {
  try {
    return normalizeIraqiPhone(input);
  } catch {
    return null;
  }
}

export function isValidE164Iraqi(value: string): boolean {
  return E164.test(value);
}

/**
 * Display form for admin screens: `0770 000 0001`.
 *
 * Never used in a log line - CLAUDE.md §9 forbids logging phone numbers, and
 * the logger redacts them structurally regardless of how they are formatted.
 */
export function formatIraqiPhoneForDisplay(e164: string): string {
  const match = E164.exec(e164);
  if (!match) return e164;
  const national = `0${match[1]!}`;
  return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
}

/**
 * Partially masked form, for the rare place a number must be shown as a hint
 * (for example "we sent a code to 0770 *** 0001").
 */
export function maskIraqiPhone(e164: string): string {
  const match = E164.exec(e164);
  if (!match) return '***';
  const national = `0${match[1]!}`;
  return `${national.slice(0, 4)} *** ${national.slice(7)}`;
}

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/** Arabic keyboards emit ٠-٩ and Persian ones ۰-۹. Both are digits to a user. */
function toWesternDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const code = char.codePointAt(0)!;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
      out += String(code - EXTENDED_ARABIC_INDIC_ZERO);
    } else {
      out += char;
    }
  }
  return out;
}
