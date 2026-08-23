import { describe, expect, it } from 'vitest';

import {
  formatIraqiPhoneForDisplay,
  InvalidPhoneNumberError,
  isValidE164Iraqi,
  maskIraqiPhone,
  normalizeIraqiPhone,
  tryNormalizeIraqiPhone,
} from './phone.js';

const CANONICAL = '+9647700000001';

describe('normalizeIraqiPhone', () => {
  // Every one of these is a form a real person types. They must ALL land on the
  // same E.164 string, or the same human ends up with two accounts and loses
  // their ride history.
  it.each([
    ['07700000001', 'national with trunk prefix'],
    ['7700000001', 'national without trunk prefix'],
    ['+9647700000001', 'E.164'],
    ['009647700000001', 'international access code'],
    ['9647700000001', 'country code without plus'],
    ['+964 770 000 0001', 'E.164 with spaces'],
    ['0770 000 0001', 'national with spaces'],
    ['0770-000-0001', 'national with dashes'],
    ['(0770) 000 0001', 'national with parentheses'],
    ['+964 (770) 000-0001', 'mixed punctuation'],
    ['+96407700000001', 'country code plus redundant trunk prefix'],
    ['  07700000001  ', 'surrounding whitespace'],
  ])('normalises %s (%s)', (input) => {
    expect(normalizeIraqiPhone(input)).toBe(CANONICAL);
  });

  // Arabic and Persian keyboards emit different digit codepoints. A user typing
  // their own number on an Arabic keyboard must not be told it is invalid.
  it('normalises Arabic-Indic digits', () => {
    expect(normalizeIraqiPhone('٠٧٧٠٠٠٠٠٠٠١')).toBe(CANONICAL);
    expect(normalizeIraqiPhone('+٩٦٤٧٧٠٠٠٠٠٠٠١')).toBe(CANONICAL);
  });

  it('normalises extended Arabic-Indic (Persian) digits', () => {
    expect(normalizeIraqiPhone('۰۷۷۰۰۰۰۰۰۰۱')).toBe(CANONICAL);
  });

  it('accepts every allocated Iraqi mobile prefix', () => {
    for (const prefix of ['74', '75', '77', '78', '79']) {
      expect(normalizeIraqiPhone(`0${prefix}01234567`)).toBe(`+964${prefix}01234567`);
    }
  });

  it('is idempotent', () => {
    expect(normalizeIraqiPhone(normalizeIraqiPhone('07700000001'))).toBe(CANONICAL);
  });

  describe('rejects', () => {
    it.each([
      ['', 'empty'],
      ['   ', 'whitespace only'],
      ['0770000000', 'one digit short'],
      ['077000000018', 'one digit too long'],
      ['06601234567', 'landline prefix'],
      ['07001234567', 'unallocated 70 prefix'],
      ['07101234567', 'unallocated 71 prefix'],
      ['+15551234567', 'a different country'],
      ['+447700123456', 'a UK number'],
      ['abcdefghijk', 'letters'],
      ['0770abc4567', 'letters mixed in'],
      ['++9647700000001', 'double plus'],
      ['964770000000', 'country code with a short national part'],
    ])('%s (%s)', (input) => {
      expect(() => normalizeIraqiPhone(input)).toThrow(InvalidPhoneNumberError);
    });

    it('non-string input', () => {
      expect(() => normalizeIraqiPhone(null as never)).toThrow(InvalidPhoneNumberError);
      expect(() => normalizeIraqiPhone(undefined as never)).toThrow(InvalidPhoneNumberError);
      expect(() => normalizeIraqiPhone(7700000001 as never)).toThrow(InvalidPhoneNumberError);
    });
  });

  // The property that actually protects against duplicate accounts.
  it('maps every accepted spelling of one number onto one identity', () => {
    const spellings = [
      '07700000001',
      '7700000001',
      '+9647700000001',
      '009647700000001',
      '9647700000001',
      '+964 770 000 0001',
      '0770-000-0001',
      '٠٧٧٠٠٠٠٠٠٠١',
    ];
    expect(new Set(spellings.map(normalizeIraqiPhone)).size).toBe(1);
  });

  it('keeps different numbers distinct', () => {
    const numbers = ['07700000001', '07700000008', '07801234567', '07501234567'];
    expect(new Set(numbers.map(normalizeIraqiPhone)).size).toBe(numbers.length);
  });

  // The regex in the users table CHECK constraint must accept everything this
  // function emits, or a valid signup fails at the database instead.
  it('always produces a value the database CHECK constraint accepts', () => {
    const dbConstraint = /^\+964[0-9]{10}$/;
    for (const prefix of ['74', '75', '77', '78', '79']) {
      for (let i = 0; i < 10; i++) {
        const normalized = normalizeIraqiPhone(`0${prefix}0123456${i}`);
        expect(normalized).toMatch(dbConstraint);
      }
    }
  });
});

describe('tryNormalizeIraqiPhone', () => {
  it('returns null instead of throwing', () => {
    expect(tryNormalizeIraqiPhone('07700000001')).toBe(CANONICAL);
    expect(tryNormalizeIraqiPhone('nonsense')).toBeNull();
  });
});

describe('isValidE164Iraqi', () => {
  it('accepts canonical values only', () => {
    expect(isValidE164Iraqi(CANONICAL)).toBe(true);
    expect(isValidE164Iraqi('07700000001')).toBe(false);
    expect(isValidE164Iraqi('+9646601234567')).toBe(false);
    expect(isValidE164Iraqi('')).toBe(false);
  });
});

describe('display helpers', () => {
  it('formats for an admin screen', () => {
    expect(formatIraqiPhoneForDisplay(CANONICAL)).toBe('0770 000 0001');
  });

  it('returns the input unchanged when it is not canonical', () => {
    expect(formatIraqiPhoneForDisplay('garbage')).toBe('garbage');
  });

  it('masks the middle digits', () => {
    expect(maskIraqiPhone(CANONICAL)).toBe('0770 *** 0001');
  });

  it('masks entirely when the input is not a valid number', () => {
    expect(maskIraqiPhone('garbage')).toBe('***');
  });

  // Asserted against a number with a DISTINCTIVE middle segment, and computed
  // from the input rather than hardcoded. A literal like `not.toContain('123')`
  // silently becomes vacuous the moment the fixture changes.
  it('never reveals the middle digits when masked', () => {
    const sample = '+9647700567001';
    const national = `0${sample.slice(4)}`; // 07700567001
    const middle = national.slice(4, 7); // '056'

    const masked = maskIraqiPhone(sample);

    expect(masked).toContain('***');
    expect(masked).not.toContain(middle);
    expect(masked).toBe('0770 *** 7001');
  });
});
