// Phone number handling for recipient lookup.
//
// The same Nigerian number gets written at least three ways — 08012345678,
// 2348012345678, +234 801 234 5678 — and WhatsApp hands us the third form with
// no '+'. Rather than pick one canonical spelling and risk missing a row that
// was stored in another, we generate every plausible spelling and look them all
// up. Cheap (an `in` query), and it removes a whole class of "recipient not
// found" failures that are really just formatting mismatches.

const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '234');

const digitsOnly = (raw) => String(raw ?? '').replace(/\D/g, '');

// Deliberately loose: this only decides whether to *try* a phone lookup, not
// whether a number is dialable. Anything with 7-15 digits and no letters is
// worth a lookup; a false positive just falls through to "not found".
const looksLikePhone = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text || /[a-z]/i.test(text)) return false;
  const digits = digitsOnly(text);
  return digits.length >= 7 && digits.length <= 15;
};

// Every spelling of `raw` worth checking against a stored phoneNumber.
const phoneCandidates = (raw) => {
  const digits = digitsOnly(raw);
  if (!digits) return [];

  const forms = new Set([digits]);

  if (digits.startsWith('0')) {
    // Local trunk form: 08012345678 -> 2348012345678
    forms.add(`${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`);
  } else if (digits.startsWith(DEFAULT_COUNTRY_CODE)) {
    // International form: 2348012345678 -> 08012345678
    forms.add(`0${digits.slice(DEFAULT_COUNTRY_CODE.length)}`);
  } else {
    // Bare subscriber number: 8012345678 -> both other forms.
    forms.add(`${DEFAULT_COUNTRY_CODE}${digits}`);
    forms.add(`0${digits}`);
  }

  // Stored numbers may or may not carry a leading '+'.
  for (const form of Array.from(forms)) forms.add(`+${form}`);

  return Array.from(forms);
};

module.exports = {
  digitsOnly,
  looksLikePhone,
  phoneCandidates,
  DEFAULT_COUNTRY_CODE,
};
