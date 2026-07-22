// Lightweight request validators shared across surfaces.
// Stellar address validation lives in stellar.service (StrKey-based) so this
// module stays free of SDK concerns; import isValidPublicKey from there.

const isValidPhoneNumber = (phone) => {
  return typeof phone === 'string' && phone.trim().length > 5;
};

const isValidAmount = (amount) => {
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed > 0;
};

const isValidName = (name) => {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 60;
};

// Mirrors the rule enforced in compliance/pin.service.js#hashPin — checking
// it here first lets callers return a clean validation error instead of
// hitting hashPin's thrown Error.
const isValidPin = (pin) => /^\d{4,6}$/.test(String(pin));

module.exports = {
  isValidPhoneNumber,
  isValidAmount,
  isValidName,
  isValidPin,
};
