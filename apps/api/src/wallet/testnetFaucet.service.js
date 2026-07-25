const { ethers } = require('ethers');
const config = require('../config/env');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const lisk = require('./lisk.adapter');
const walletService = require('./wallet.service');
const { ensureGas } = require('../payment/gasTopup');
const { writeAuditLog } = require('../common/audit.service');

// In-chat testnet funding: "fund me" drips USDC.e from the platform treasury
// into the asking user's wallet.
//
// Funding a self-custodied wallet is otherwise a genuinely awkward errand —
// claim from Circle's faucet on Ethereum Sepolia, then bridge to Lisk, and the
// user cannot even do it themselves because their key lives encrypted in this
// backend and is never handed out. That work moves to the operator, who tops
// the treasury up occasionally (scripts/bridge-usdc-to-lisk.js --to <treasury>),
// while users just ask the bot and are funded instantly with no bridging.
//
// Gas is topped up in the same breath, since USDC.e you cannot pay to move is
// no use.

const DRIP_TYPE = 'faucet_drip';

// Chain ids where handing out tokens on request is meaningful. Lisk mainnet
// (1135) is deliberately absent: on mainnet this would be an open drain on
// real funds for anyone who can send a WhatsApp message.
const TESTNET_CHAIN_IDS = new Set([4202]);

const treasuryAddress = () => config.lisk.faucetWalletAddress || config.lisk.gasWalletAddress;

// Uses the adapter's resolved chain id, not raw config: LISK_CHAIN_ID is
// commonly a name like 'lisk-sepolia' rather than a number, which Number()
// turns into NaN. Deriving it separately here would silently disable the
// faucet on exactly the testnet it's meant for.
const isTestnet = () => TESTNET_CHAIN_IDS.has(lisk.resolvedChainId());

const configured = () => Boolean(config.faucet.enabled && treasuryAddress() && isTestnet());

// Why the faucet isn't available, for operators reading logs — never shown to
// the user verbatim.
const unavailableReason = () => {
  if (!config.faucet.enabled) return 'TESTNET_FAUCET_ENABLED is false';
  if (!isTestnet()) return `chain ${config.lisk.chainId} is not a known testnet`;
  if (!treasuryAddress()) return 'no LISK_FAUCET_WALLET_ADDRESS or LISK_GAS_WALLET_ADDRESS is set';
  return null;
};

const hoursUntil = (since, cooldownHours) => {
  const readyAt = new Date(since).getTime() + cooldownHours * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((readyAt - Date.now()) / (60 * 60 * 1000)));
};

/**
 * Drips testnet USDC.e to a user. Never throws — every outcome is a message
 * the user receives.
 *
 * @returns {Promise<{status: string, message: string}>} status is one of:
 *   sent, unavailable, cooling_down, capped, treasury_empty, failed.
 */
const dispense = async ({ user }) => {
  if (!configured()) {
    logger.warn(`Testnet faucet requested but unavailable: ${unavailableReason()}`);
    return {
      status: 'unavailable',
      message: "Test funds aren't available right now. If you're testing, ask the team to top up the faucet.",
    };
  }

  const wallet = await walletService.createOrGetWallet({ user });
  const destination = wallet.address || wallet.publicKey;
  if (!destination) {
    return {
      status: 'failed',
      message: "You don't have a wallet yet. Reply \"setup\" and I'll send you the link to create one.",
    };
  }

  // Cooldown and lifetime cap both read from the Transaction ledger rather than
  // new columns — the drip is already recorded there, and that doubles as the
  // audit trail for where treasury funds went.
  const [lastDrip, dripCount] = await Promise.all([
    prisma.transaction.findFirst({
      where: { userId: user.id, type: DRIP_TYPE, status: 'success' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.transaction.count({
      where: { userId: user.id, type: DRIP_TYPE, status: 'success' },
    }),
  ]);

  if (dripCount >= config.faucet.maxPerUser) {
    return {
      status: 'capped',
      message: `You've already claimed test funds ${dripCount} times, which is the limit. Ask the team if you need more.`,
    };
  }

  if (lastDrip) {
    const wait = hoursUntil(lastDrip.createdAt, config.faucet.cooldownHours);
    if (wait > 0) {
      return {
        status: 'cooling_down',
        message: `You've already claimed test funds recently. Try again in about ${wait} ${wait === 1 ? 'hour' : 'hours'}.`,
      };
    }
  }

  const amount = config.faucet.amount;
  const treasury = treasuryAddress();

  // Check the treasury can cover this before doing anything, so an empty
  // faucet says so instead of failing mid-transfer.
  let treasuryBalance;
  try {
    treasuryBalance = await lisk.getBalance({ address: treasury });
  } catch (error) {
    logger.error(`Faucet could not read the treasury balance: ${error.message}`);
    return { status: 'failed', message: "Couldn't reach the network just now — please try again shortly." };
  }

  if (Number(treasuryBalance.value) < Number(amount)) {
    logger.error(
      `Faucet treasury ${treasury} is empty: holds ${treasuryBalance.value} USDC.e, needs ${amount}. ` +
        'Top it up with: node scripts/bridge-usdc-to-lisk.js --amount 100 --to ' + treasury
    );
    return {
      status: 'treasury_empty',
      message: "The test faucet has run dry. The team has been alerted — please try again later.",
    };
  }

  const transaction = await prisma.transaction.create({
    data: {
      userId: user.id,
      type: DRIP_TYPE,
      amount: String(amount),
      asset: 'USDC',
      rail: 'lisk',
      routeType: 'faucet',
      destination,
      status: 'processing',
      metadata: { treasury },
    },
  });

  try {
    // Gas first: USDC.e the user cannot afford to move is no use to them. A
    // failure here shouldn't block the drip — they may already have gas.
    try {
      await ensureGas({ wallet, idempotencyKey: transaction.id });
    } catch (gasError) {
      logger.warn(`Faucet could not top up gas for ${destination}: ${gasError.message}`);
    }

    const result = await lisk.sendToken({
      fromAddress: treasury,
      destination,
      amount,
      tokenAddress: config.lisk.usdcContractAddress,
    });

    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: 'success', txHash: result.transactionHash, explorerUrl: result.explorerUrl },
    });

    await writeAuditLog({
      actorType: 'system',
      actorId: String(user.id),
      action: 'faucet.dispensed',
      entityType: 'Transaction',
      entityId: String(transaction.id),
      metadata: { amount, destination, treasury },
    });

    const link = result.explorerUrl ? `\n${result.explorerUrl}` : '';
    return {
      status: 'sent',
      message: `Sent you ${amount} test USDC — it's in your wallet now. Say "balance" to see it, or try sending some to a friend.${link}`,
    };
  } catch (error) {
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: 'failed', metadata: { treasury, error: error.message } },
    });
    logger.error(`Faucet drip to ${destination} failed: ${error.message}`);
    return {
      status: 'failed',
      message: "Couldn't send your test funds just now — nothing was charged. Please try again in a moment.",
    };
  }
};

module.exports = {
  dispense,
  configured,
  unavailableReason,
  treasuryAddress,
  isTestnet,
  DRIP_TYPE,
};
