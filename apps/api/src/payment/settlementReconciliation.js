const config = require('../config/env');
const settlementClient = require('../settlement/settlement.client');
const logger = require('../utils/logger');
const { toMinorUnits } = require('../pricing/pricing.service');

// Records the platform's fee revenue from a successfully executed on-chain
// send into sendam-settlement's ledger, purely for internal treasury
// bookkeeping/reconciliation. The on-chain wallet stays the source of truth
// for user-facing balances (see wallet.service.js) — this never gates or
// blocks the payment response, it only logs on failure.
const recordFeeReconciliation = async ({ transaction }) => {
  if (!settlementClient.configured()) return;

  const feeAmount = transaction.metadata?.fee;
  if (!feeAmount || Number(feeAmount) <= 0) return;

  try {
    await settlementClient.credit({
      userId: config.settlement.treasuryUserId,
      chain: transaction.rail,
      asset: transaction.asset,
      amountMinorUnits: toMinorUnits(feeAmount),
      idempotencyKey: transaction.id,
    });
  } catch (error) {
    logger.warn(`sendam-settlement reconciliation failed for transaction ${transaction.id}: ${error.message}`);
  }
};

module.exports = { recordFeeReconciliation };
