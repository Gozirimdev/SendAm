const config = require('../config/env');
const lisk = require('../wallet/lisk.adapter');
const paymaster = require('../paymaster/paymaster.client');
const logger = require('../utils/logger');

// Self-custodied Lisk wallets have no relayer: the sending address must hold
// native LSK to pay gas, or the token transfer simply reverts. Before every
// on-chain send we ask sendam-paymaster whether this wallet needs topping up
// (it embeds the target-balance/hysteresis policy so we don't duplicate it
// here) and, if so, execute the top-up ourselves — paymaster only plans, it
// never submits (see paymaster.client.js).
const ensureGas = async ({ wallet, idempotencyKey }) => {
  if (!paymaster.configured()) {
    logger.warn('sendam-paymaster is not configured; skipping gas top-up check.');
    return { toppedUp: false };
  }

  const { raw: currentBalanceWei } = await lisk.getNativeBalance({ address: wallet.address });
  const plan = await paymaster.planGasTopup({
    address: wallet.address,
    currentBalanceWei,
    idempotencyKey,
  });

  if (!plan.shouldTopUp) {
    return { toppedUp: false, reason: plan.reason };
  }

  if (!config.lisk.gasWalletAddress) {
    throw new Error('Wallet needs a gas top-up but LISK_GAS_WALLET_ADDRESS is not configured.');
  }

  const result = await lisk.sendNative({
    fromAddress: config.lisk.gasWalletAddress,
    destination: wallet.address,
    amountWei: plan.amountWei,
  });

  return { toppedUp: true, amountWei: plan.amountWei, txHash: result.transactionHash };
};

module.exports = { ensureGas };
