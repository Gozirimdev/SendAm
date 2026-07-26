const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const config = require('../config/env');
const { executePayment } = require('../payment/payment.orchestrator');
const { verifyPin } = require('../compliance/pin.service');
const { isValidPin } = require('../utils/validators');
const faucet = require('../faucet/faucet.service');

// The single place a confirmed payment is actually carried out.
//
// Two surfaces collect the PIN — the encrypted WhatsApp Flow (pinFlow.service)
// and, when no Flow is configured, a PIN typed into the chat thread
// (assistant.service). Both funnel through here so they can never drift on
// what "confirmed" means, and so neither can reintroduce the original bug:
// nothing below is allowed to throw. Every failure resolves to a message the
// user actually receives.

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;

const clearPendingSend = (userId) =>
  prisma.user.update({ where: { id: userId }, data: { pendingSend: null } });

const recordAttempt = (userId, pending, attempts) =>
  prisma.user.update({
    where: { id: userId },
    data: { pendingSend: { ...pending, pinAttempts: attempts } },
  });

const isExpired = (pending) =>
  Date.now() - new Date(pending.requestedAt).getTime() > PENDING_SEND_TTL_MS;

// Maps an execution failure onto something a non-technical user can act on.
// The raw message is logged, never sent: it can carry an RPC URL, a contract
// address, or a stack-shaped string.
const describeExecutionError = (error) => {
  const message = String(error?.message || '');

  if (/KYC approval is required/i.test(message)) {
    return "Your account isn't verified for payments yet. Reply \"verify\" and I'll send you the link to finish setup.";
  }
  if (/single transaction limit/i.test(message)) {
    return "That's above your per-payment limit. Try a smaller amount, or reply \"verify\" to raise your limits.";
  }
  if (/daily limit/i.test(message)) {
    return "That would put you over your daily limit. Try again tomorrow, or reply \"verify\" to raise your limits.";
  }
  if (/manual compliance review/i.test(message)) {
    return 'That payment needs a manual review before it can go through. Our team will be in touch.';
  }
  // The two "not enough money" cases are completely different problems and
  // need different actions from the user, so they must never share a message.
  // Both are raised by the orchestrator's preflight with the real figures
  // attached; the balances are the user's own, so quoting them back is fine.
  const shortfall = message.match(/INSUFFICIENT_(?:TOKEN|GAS)_BALANCE: wallet holds (\S+) (\S+), needs (\S+)/);
  if (message.startsWith('INSUFFICIENT_TOKEN_BALANCE')) {
    const [, have, symbol, need] = shortfall || [];
    // On testnet, point at the thing that actually fixes it rather than
    // leaving "add funds" as an exercise the user can't complete — their key
    // is held by this backend, so they can't fund the wallet themselves.
    const remedy = faucet.configured()
      ? ' Say "fund me" and I\'ll top you up with test USDC.'
      : ' Add funds and try again.';
    return `You don't have enough ${symbol || 'USDC'} for that payment — your wallet holds ${have || '0'}, and you tried to send ${need || 'more'}. Nothing was sent.${remedy}`;
  }
  if (message.startsWith('INSUFFICIENT_GAS_BALANCE')) {
    const [, have] = shortfall || [];
    return `Your wallet has the funds to send, but not enough ${config.lisk.nativeSymbol} to pay the network fee (it holds ${have || '0'} ${config.lisk.nativeSymbol}). Nothing was sent — a tiny amount, around 0.0001 ${config.lisk.nativeSymbol}, covers over a thousand transfers.`;
  }

  // Post-hoc revert strings, for anything that slipped past the preflight
  // (a balance that changed between the check and the send).
  if (/intrinsic transaction cost|insufficient funds for gas/i.test(message)) {
    return `Your wallet doesn't have enough ${config.lisk.nativeSymbol} to pay the network fee. Nothing was sent.`;
  }
  if (/insufficient|exceeds balance|transfer amount exceeds/i.test(message)) {
    return "You don't have enough in your wallet for that payment. Nothing was sent — check \"balance\" and try again.";
  }
  if (/gas|LISK_GAS_WALLET_ADDRESS|paymaster/i.test(message)) {
    return "I couldn't cover the network fee for that transfer right now. Nothing was sent — please try again shortly.";
  }
  if (/Lisk RPC is not configured|RPC|network|timeout|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return "The network is not responding right now, so I didn't send anything. Please try again in a few minutes.";
  }
  if (/invalid address|unconfigured name|ENS/i.test(message)) {
    return "That recipient address isn't valid, so nothing was sent. Send me their phone number or a wallet address starting 0x.";
  }
  return "Something went wrong while sending — nothing has left your wallet. Please try again in a moment.";
};

/**
 * Verifies a PIN against a user's pending send and, on success, executes it.
 * Never throws.
 *
 * @returns {Promise<{status: string, message: string}>} status is one of:
 *   sent, wrong_pin, locked_out, expired, no_pending, malformed_pin, failed.
 */
const confirmPendingSend = async ({ user, pin }) => {
  const pending = user.pendingSend;
  if (!pending?.destination) {
    return { status: 'no_pending', message: "There's no payment waiting for confirmation right now." };
  }

  if (isExpired(pending)) {
    await clearPendingSend(user.id);
    return { status: 'expired', message: 'That payment request expired, so nothing was sent. Please start again.' };
  }

  if (!isValidPin(pin)) {
    return { status: 'malformed_pin', message: 'Your PIN is 4 to 6 digits. Please try again.' };
  }

  // Re-read so the PIN is checked against the current hash, not a copy that
  // may have been loaded before the user changed it.
  const current = await prisma.user.findUnique({ where: { id: user.id } });
  if (!current?.pinHash) {
    await clearPendingSend(user.id);
    return {
      status: 'failed',
      message: "You haven't set a payment PIN yet, so I can't authorise that. Reply \"setup\" and I'll send you the link.",
    };
  }

  if (!verifyPin(pin, current.pinHash)) {
    const attempts = Number(pending.pinAttempts || 0) + 1;
    const remaining = config.compliance.maxPinAttempts - attempts;
    if (remaining <= 0) {
      await clearPendingSend(user.id);
      return {
        status: 'locked_out',
        message: 'Too many incorrect PIN attempts — that payment has been cancelled for your safety. Start again when you\'re ready.',
      };
    }
    await recordAttempt(user.id, pending, attempts);
    return {
      status: 'wrong_pin',
      message: `That PIN wasn't right. ${remaining} ${remaining === 1 ? 'try' : 'tries'} left.`,
    };
  }

  // Clear the pending send *before* executing. A payment that fails halfway
  // must not leave a re-confirmable request behind, and it must not leave the
  // user trapped in PIN-entry state — that trap is what made the original bug
  // eat every message the user sent afterwards.
  await clearPendingSend(user.id);

  try {
    const result = await executePayment({
      sender: current,
      destination: pending.destination,
      amount: pending.amount,
      asset: pending.asset || 'USDC',
      routeType: pending.routeType,
    });

    const status = result.transaction.status;
    const explorer = result.receipt.receiptUrl ? `\n${result.receipt.receiptUrl}` : '';
    const message =
      status === 'success'
        ? `Sent ${pending.amount} ${pending.asset || 'USDC'} to ${pending.alias || pending.destination}.\nReceipt: ${result.receipt.transactionId}${explorer}`
        : `Your payment of ${pending.amount} ${pending.asset || 'USDC'} to ${pending.alias || pending.destination} is ${status}.\nReceipt: ${result.receipt.transactionId}`;

    return { status: 'sent', message, transaction: result.transaction };
  } catch (error) {
    logger.error(`Payment execution failed for user ${user.id}: ${error.message}`);
    return { status: 'failed', message: describeExecutionError(error) };
  }
};

module.exports = {
  confirmPendingSend,
  describeExecutionError,
  clearPendingSend,
  isExpired,
  PENDING_SEND_TTL_MS,
};
