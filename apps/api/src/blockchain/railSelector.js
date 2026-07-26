// Which rail carries a payment.
//
// Lisk settles everything on-chain, domestic and cross-border alike. Whether a
// payment crosses a border is still tracked as a distinct `routeType` for
// compliance limits (see payment.orchestrator.js) — it just isn't a separate
// rail.
//
// `sourceCountry` and `destinationCountry` are still accepted so callers don't
// have to change, and so a dedicated corridor rail has an obvious place to hook
// in if one is ever added.
const selectRail = ({ routeType, forceRail } = {}) => {
  if (forceRail) return forceRail;
  if (routeType === 'cash_in') return 'yellow-card';
  if (routeType === 'cash_out') return 'paychant';
  if (routeType === 'escrow') return 'lisk';
  return 'lisk';
};

module.exports = {
  selectRail,
};
