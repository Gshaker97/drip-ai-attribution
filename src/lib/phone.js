import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Normalize a phone number to E.164 format (e.g. +14805551234)
 * Returns null if the number cannot be parsed.
 */
export function normalizePhone(raw, defaultCountry = 'US') {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;

  try {
    const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
    if (parsed && parsed.isValid()) {
      return parsed.number; // E.164 format
    }
  } catch (e) {
    // fall through
  }

  // Fallback: strip everything non-numeric, prepend + if it looks like a US number
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/**
 * Normalize an email for comparison (lowercase, trim).
 */
export function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed || null;
}
