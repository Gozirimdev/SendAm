// Lightweight request validators shared across surfaces.
// chain address validation lives in chain.service (AddressCodec-based) so this
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
