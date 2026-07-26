const { ethers } = require('ethers');
const config = require('../config/env');
const lisk = require('../chain/lisk.reader');
const custody = require('../custody/custody.client');
const paymaster = require('../paymaster/paymaster.client');
const logger = require('../utils/logger');

// Custodied Lisk wallets have no relayer: the sending address must hold native
// ETH to pay gas, or the token transfer simply reverts. (Gas on Lisk is ETH —
// it is an OP Stack L2 and inherits L1's native currency. LSK itself is an
// ordinary ERC-20 here and cannot pay for anything.)
//
// Two ways to get that ETH into a user's wallet:
//
//   1. sendam-paymaster, when configured — it embeds the target-balance and
//      hysteresis policy so we don't duplicate it here. It only ever *plans*;
//      submitting the top-up is still our job (see paymaster.client.js).
//
//   2. The local policy below, when it isn't. Previously this branch logged a
//      warning and returned, meaning every freshly created wallet went to its
//      first send with a zero balance and reverted — the whole feature was
//      inert until an entire extra microservice was deployed. A threshold and
//      a target are all the policy actually needs, so they live here as env
//      knobs and a funded LISK_GAS_WALLET_ADDRESS is enough on its own.

// Below this, top up. Above it, leave alone. Denominated in whole ETH because
// that is how a human reasons about funding a wallet.
const minBalanceWei = () => ethers.parseEther(String(config.lisk.gasMinBalance));
const topUpToWei = () => ethers.parseEther(String(config.lisk.gasTopUpTo));

const planLocally = async ({ wallet }) => {
  const { raw } = await lisk.getNativeBalance({ address: wallet.address });
  const current = BigInt(raw);
  const floor = minBalanceWei();

  if (current >= floor) {
    return { shouldTopUp: false, reason: 'at-or-above-threshold' };
  }

  const target = topUpToWei();
  if (target <= current) {
    // Misconfiguration: topping up to at-or-below the floor would either be a
    // no-op or re-trigger on every single send.
    throw new Error(
      `LISK_GAS_TOPUP_TO (${config.lisk.gasTopUpTo}) must be greater than LISK_GAS_MIN_BALANCE (${config.lisk.gasMinBalance}).`
    );
  }

  return { shouldTopUp: true, amountWei: (target - current).toString(), reason: 'below-threshold' };
};

const ensureGas = async ({ wallet, idempotencyKey }) => {
  const usingPaymaster = paymaster.configured();

  let plan;
  if (usingPaymaster) {
    const { raw: currentBalanceWei } = await lisk.getNativeBalance({ address: wallet.address });
    plan = await paymaster.planGasTopup({
      address: wallet.address,
      currentBalanceWei,
      idempotencyKey,
    });
  } else {
    if (!config.lisk.gasWalletAddress) {
      // Nothing can be done, but say so precisely — this is the single most
      // likely reason a correctly-funded user still can't send.
      logger.warn(
        'No gas funding is configured: set LISK_GAS_WALLET_ADDRESS, or configure sendam-paymaster. User wallets with no ETH will fail to send.'
      );
      return { toppedUp: false, reason: 'no-gas-funding-configured' };
    }
    plan = await planLocally({ wallet });
  }

  if (!plan.shouldTopUp) {
    return { toppedUp: false, reason: plan.reason };
  }

  if (!config.lisk.gasWalletAddress) {
    throw new Error('Wallet needs a gas top-up but LISK_GAS_WALLET_ADDRESS is not configured.');
  }

  // Check the gas wallet can actually cover this before submitting, so an
  // empty treasury reports itself rather than surfacing as an opaque revert
  // on the user's payment.
  const { raw: gasWalletRaw } = await lisk.getNativeBalance({ address: config.lisk.gasWalletAddress });
  if (BigInt(gasWalletRaw) < BigInt(plan.amountWei)) {
    throw new Error(
      `GAS_WALLET_EMPTY: the platform gas wallet ${config.lisk.gasWalletAddress} holds ` +
        `${ethers.formatEther(gasWalletRaw)} ${config.lisk.nativeSymbol} but needs ` +
        `${ethers.formatEther(plan.amountWei)} to top up a user wallet.`
    );
  }

  // Namespaced off the caller's key so a top-up and the payment that triggered
  // it never collide on one idempotency key inside custody.
  const result = await custody.transferNative({
    from: config.lisk.gasWalletAddress,
    to: wallet.address,
    amountWei: plan.amountWei,
    idempotencyKey: `${idempotencyKey}:gas-topup`,
  });

  logger.info(
    `Topped up ${wallet.address} with ${ethers.formatEther(plan.amountWei)} ${config.lisk.nativeSymbol} ` +
      `(${usingPaymaster ? 'paymaster' : 'local'} policy)`
  );

  return { toppedUp: true, amountWei: plan.amountWei, txHash: result.txHash };
};

module.exports = { ensureGas };
