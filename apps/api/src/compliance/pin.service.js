const crypto = require('crypto');
const config = require('../config/env');
const { isValidPin } = require('../utils/validators');

const hashPin = (pin) => {
  if (!isValidPin(pin)) throw new Error('PIN must be 4 to 6 digits.');
  const pepper = config.compliance.pinPepper || config.admin.jwtSecret || 'development-only-pin-pepper';
  return crypto.createHmac('sha256', pepper).update(String(pin)).digest('hex');
};

// Never throws. A malformed PIN — wrong length, non-digits, the trailing
// whitespace WhatsApp clients love to add — is a *failed verification*, not an
// exception. It used to propagate hashPin's throw, which unwound the entire
// inbound-message job and left the user with no reply at all: the single
// biggest cause of "I entered my PIN and nothing happened".
const verifyPin = (pin, pinHash) => {
  if (!pinHash) return false;
  if (!isValidPin(pin)) return false;

  const expected = Buffer.from(hashPin(pin), 'utf8');
  const actual = Buffer.from(String(pinHash), 'utf8');
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  // This leaks only the stored hash's length (a constant 64 hex chars), never
  // anything about the PIN itself.
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
};

module.exports = {
  hashPin,
  verifyPin,
};
