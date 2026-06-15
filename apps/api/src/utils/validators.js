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

module.exports = {
  isValidPhoneNumber,
  isValidAmount,
};
