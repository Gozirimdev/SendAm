const { ethers } = require('ethers');
const config = require('../config/env');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const lisk = require('../chain/lisk.reader');
const custody = require('../custody/custody.client');
const accountService = require('../account/account.service');
const { ensureGas } = require('../payment/gasTopup');
const { writeAuditLog } = require('../common/audit.service');

// In-chat testnet funding: "fund me" drips USDC.e from the platform treasury
// into the asking user's wallet.
//
// Funding a custodied wallet is otherwise a genuinely awkward errand — claim
// from Circle's faucet on Ethereum Sepolia, then bridge to Lisk, and the user
// cannot even do it themselves because their key lives in sendam-custody and is
// never handed out. That work moves to the operator, who tops the treasury up
// occasionally, while users just ask the bot and are funded instantly with no
// bridging.
//
// Gas is topped up in the same breath, since USDC.e you cannot pay to move is
// no use.

const DRIP_TYPE = 'faucet_drip';

// Chain ids where handing out tokens on request is meaningful. Lisk mainnet
// (1135) is deliberately absent: on mainnet this would be an open drain on
// real funds for anyone who can send a WhatsApp message.
const TESTNET_CHAIN_IDS = new Set([4202]);

// The reserved owner of the platform's system wallet — used both as the local
// User.phoneNumber sentinel and as the custody `ref`, so the two sides agree on
// which wallet is the treasury without a second lookup table.
const SYSTEM_PHONE = 'system:lisk-gas-wallet';

const configuredTreasury = () => config.lisk.faucetWalletAddress || config.lisk.gasWalletAddress;

// Uses the reader's resolved chain id, not raw config: LISK_CHAIN_ID is
// commonly a name like 'lisk-sepolia' rather than a number, which Number()
// turns into NaN. Deriving it separately here would silently disable the
// faucet on exactly the testnet it's meant for.
const isTestnet = () => TESTNET_CHAIN_IDS.has(lisk.resolvedChainId());

// Deliberately does NOT require a treasury address. Requiring one made the
// whole feature unreachable for anyone who doesn't control the API's
// environment. The treasury is resolved from the database and provisioned on
// demand through sendam-custody, so the only thing a human still has to do is
// send test funds to an address.
//
// Custody is a hard requirement, though: without it there is nothing that can
// sign a payout at all.
const configured = () => Boolean(config.faucet.enabled && isTestnet() && custody.configured());

// Why the faucet isn't available, for operators reading logs — never shown to
// the user verbatim.
const unavailableReason = () => {
  if (!config.faucet.enabled) return 'TESTNET_FAUCET_ENABLED is false';
  if (!isTestnet()) return `chain ${config.lisk.chainId} is not a known testnet`;
  if (!custody.configured()) return 'sendam-custody is not configured (CUSTODY_BASE_URL / CUSTODY_SIGNING_SECRET)';
  return null;
};

/**
 * The wallet the faucet pays out of, creating it if it doesn't exist yet.
 *
 * An explicit LISK_FAUCET_WALLET_ADDRESS / LISK_GAS_WALLET_ADDRESS still wins,
 * for deployments that manage the treasury themselves. Otherwise we look for
 * the system wallet in the database and, failing that, ask custody to mint one.
 * Custody is idempotent on `ref`, so concurrent "fund me" requests converge on
 * a single treasury rather than each minting one and stranding funds in the
 * loser.
 *
 * @returns {Promise<{address: string, created: boolean}>}
 */
const resolveTreasury = async () => {
  const explicit = configuredTreasury();
  if (explicit) return { address: explicit, created: false };

  const existing = await prisma.wallet.findFirst({ where: { phoneNumber: SYSTEM_PHONE } });
  if (existing?.address) return { address: existing.address, created: false };

  const custodied = await custody.createWallet({ ref: SYSTEM_PHONE });

  // Mirror the custody wallet into a local row so the address is readable
  // without a round trip. The unique constraint on User.phoneNumber is the
  // arbiter: whoever loses the race re-reads the winner's wallet.
  let owner;
  try {
    owner = await prisma.user.create({
      data: { phoneNumber: SYSTEM_PHONE, preferredName: 'SendAm faucet treasury' },
    });
  } catch (error) {
    if (error.code !== 'P2002') throw error;
    const raced = await prisma.wallet.findFirst({ where: { phoneNumber: SYSTEM_PHONE } });
    if (raced?.address) return { address: raced.address, created: false };
    owner = await prisma.user.findUnique({ where: { phoneNumber: SYSTEM_PHONE } });
  }

  const wallet = await prisma.wallet.create({
    data: {
      userId: owner.id,
      phoneNumber: SYSTEM_PHONE,
      provider: 'custody',
      providerWalletId: custodied.ref,
      address: custodied.address,
      publicKey: custodied.address,
      primaryChain: 'lisk',
      supportedChains: ['lisk'],
      network: 'custody',
    },
  });
  await prisma.user.update({ where: { id: owner.id }, data: { walletId: wallet.id } });

  if (custodied.created) {
    logger.warn(
      `Created the faucet treasury ${custodied.address}. It is empty — send it testnet ETH and USDC.e before "fund me" can pay out.`
    );
  }
  await writeAuditLog({
    actorType: 'system',
    actorId: 'faucet',
    action: 'faucet.treasury_created',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: { address: custodied.address },
  });

  return { address: custodied.address, created: true };
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
      message: "I can't send test funds here — ask the team to fund your wallet and they can do it from their side.",
    };
  }

  const wallet = await accountService.createOrGetWallet({ user });
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

  let treasury;
  try {
    ({ address: treasury } = await resolveTreasury());
  } catch (error) {
    logger.error(`Faucet could not resolve a treasury: ${error.message}`);
    return { status: 'failed', message: "Couldn't set up test funding just now — please try again shortly." };
  }

  // Check the treasury can cover this before doing anything, so an empty
  // faucet says so instead of failing mid-transfer.
  let treasuryUsdc;
  let treasuryGas;
  try {
    [treasuryUsdc, treasuryGas] = await Promise.all([
      lisk.getBalance({ address: treasury }),
      lisk.getNativeBalance({ address: treasury }),
    ]);
  } catch (error) {
    logger.error(`Faucet could not read the treasury balance: ${error.message}`);
    return { status: 'failed', message: "Couldn't reach the network just now — please try again shortly." };
  }

  if (Number(treasuryUsdc.value) < Number(amount)) {
    logger.error(
      `Faucet treasury ${treasury} is short: holds ${treasuryUsdc.value} USDC.e, needs ${amount}.`
    );
    // The address is in the reply on purpose. Whoever is testing is usually
    // also whoever can fund it, and a dead end that doesn't say where to send
    // money is what made this feature unusable in the first place. Testnet
    // addresses are public, so there is nothing to leak.
    return {
      status: 'treasury_empty',
      message:
        `The test faucet is empty, so I can't send you anything yet.\n\n` +
        `Whoever is running this can top it up by sending testnet ETH and USDC.e to:\n${treasury}`,
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
    // Gas first: USDC.e the user cannot afford to move is no use to them.
    //
    // ensureGas only acts when a gas wallet is configured, which for a
    // deployment relying on the auto-provisioned treasury it is not — so fall
    // back to sending gas from the treasury itself. Same wallet, one thing to
    // fund. A failure here never blocks the drip: they may already have gas,
    // and USDC without gas still beats nothing.
    try {
      const topUp = await ensureGas({ wallet, idempotencyKey: transaction.id });
      if (!topUp.toppedUp) {
        const userGas = await lisk.getNativeBalance({ address: destination });
        const floor = ethers.parseEther(String(config.lisk.gasMinBalance));
        const target = ethers.parseEther(String(config.lisk.gasTopUpTo));
        const need = target - BigInt(userGas.raw);

        if (BigInt(userGas.raw) < floor && need > 0n && BigInt(treasuryGas.raw) >= need) {
          await custody.transferNative({
            from: treasury,
            to: destination,
            amountWei: need.toString(),
            idempotencyKey: `${transaction.id}:gas`,
          });
          logger.info(`Faucet sent ${ethers.formatEther(need)} ETH of gas to ${destination}`);
        } else if (BigInt(userGas.raw) < floor) {
          logger.warn(
            `Faucet treasury ${treasury} has ${treasuryGas.value} ETH — not enough to give ${destination} gas. ` +
              'Send it testnet ETH from https://console.optimism.io/faucet'
          );
        }
      }
    } catch (gasError) {
      logger.warn(`Faucet could not top up gas for ${destination}: ${gasError.message}`);
    }

    const result = await custody.transfer({
      from: treasury,
      to: destination,
      amount,
      tokenAddress: config.lisk.usdcContractAddress,
      idempotencyKey: transaction.id,
    });

    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: 'success', txHash: result.txHash, explorerUrl: result.explorerUrl },
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
  resolveTreasury,
  configuredTreasury,
  isTestnet,
  SYSTEM_PHONE,
  DRIP_TYPE,
};
