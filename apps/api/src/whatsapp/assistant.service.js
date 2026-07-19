const walletService = require('../wallet/wallet.service');
const { executePayment } = require('../payment/payment.orchestrator');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { verifyPin } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const sendamAi = require('../sendamAi/sendamAi.client');
const { writeAuditLog } = require('../common/audit.service');

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;

const resolveUser = async (phoneNumber, whatsappName) => {
  let user = await prisma.user.findUnique({ where: { phoneNumber } });
  if (!user) {
    user = await prisma.user.create({ data: { phoneNumber, whatsappName } });
  } else if (whatsappName && user.whatsappName !== whatsappName) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { whatsappName },
    });
  }
  return user;
};

// Maps a sendam-ai /decode result onto the shape requestConfirmation()
// expects, or returns null if it's not an actionable SEND. Never trusts the
// amount blindly: compliance.service.js does Number(amount) comparisons
// against spend limits, and every comparison against NaN is false — a
// non-numeric amount would silently sail through those limit checks instead
// of being rejected. asset defaults to 'USDC' here for the confirmation
// message's display text (sendam-ai deliberately never guesses an asset);
// executePayment() has its own separate 'USDC' default for the actual
// transfer, so this default is about not showing the user "Amount: 5000
// null", not about execution correctness.
const mapDecodedIntent = (decoded) => {
  if (!decoded || decoded.intent !== 'SEND') return null;
  if (!decoded.recipient) return null;
  const amount = Number(decoded.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    amount: decoded.amount,
    asset: (decoded.asset || 'USDC').toUpperCase(),
    recipient: decoded.recipient,
  };
};

// sendam-ai reads the feeling behind the user's own words and opens in a
// matching tone rather than one fixed line every time — reply is the only
// field it fills in for GREETING (every other intent leaves it null), so a
// missing/empty reply here means something upstream is wrong, not that
// GREETING itself is unhandled. Fall back to a static line rather than
// silently treating it as an unrecognized message.
const FALLBACK_GREETING_REPLY = 'Hi! I can help you send money, check balance, receive money, start escrow, find cash-out agents, or show receipts.';

const resolveGreetingReply = (decoded) => {
  if (!decoded || decoded.intent !== 'GREETING') return null;
  return decoded.reply || FALLBACK_GREETING_REPLY;
};

const resolveRecipient = async (user, recipient) => {
  const alias = String(recipient || '').trim().toLowerCase();
  const savedAlias = await prisma.alias.findUnique({
    where: { userId_alias: { userId: user.id, alias } },
  });
  if (savedAlias) return { destination: savedAlias.target, label: alias };
  return { destination: recipient, label: recipient };
};

const requestConfirmation = async ({ phoneNumber, user, intent }) => {
  const recipient = await resolveRecipient(user, intent.recipient);
  const pendingSend = {
    amount: intent.amount,
    asset: intent.asset,
    destination: recipient.destination,
    alias: recipient.label,
    routeType: 'domestic',
    requestedAt: new Date(),
  };
  await prisma.user.update({
    where: { id: user.id },
    data: { pendingSend },
  });

  await sendTextMessage(
    phoneNumber,
    `Please confirm this payment:\nAmount: ${intent.amount} ${intent.asset}\nTo: ${recipient.label}\nReply with your PIN to send, or "no" to cancel.`
  );
};

const handlePendingPin = async ({ phoneNumber, user, text }) => {
  if (!user.pendingSend?.destination) return false;

  const lowered = String(text).trim().toLowerCase();
  if (lowered === 'no' || lowered === 'cancel') {
    await prisma.user.update({ where: { id: user.id }, data: { pendingSend: null } });
    await sendTextMessage(phoneNumber, 'Payment cancelled.');
    return true;
  }

  if (Date.now() - new Date(user.pendingSend.requestedAt).getTime() > PENDING_SEND_TTL_MS) {
    await prisma.user.update({ where: { id: user.id }, data: { pendingSend: null } });
    await sendTextMessage(phoneNumber, 'That payment request expired. Please start again.');
    return true;
  }

  const userWithPin = await prisma.user.findUnique({ where: { id: user.id } });
  if (!verifyPin(text, userWithPin.pinHash)) {
    await sendTextMessage(phoneNumber, 'PIN verification failed. Please try again or reply "no" to cancel.');
    return true;
  }

  const pending = user.pendingSend;
  await enforceTransactionPolicy({
    user,
    amount: pending.amount,
    routeType: pending.routeType,
    destinationCountry: 'NG',
  });

  const result = await executePayment({
    sender: user,
    destination: pending.destination,
    amount: pending.amount,
    asset: pending.asset || 'USDC',
    routeType: pending.routeType,
  });

  await prisma.user.update({ where: { id: user.id }, data: { pendingSend: null } });

  await sendTextMessage(phoneNumber, `Payment ${result.transaction.status}. Receipt: ${result.receipt.transactionId}`);
  return true;
};

const processMessage = async (phoneNumber, whatsappName, text) => {
  const user = await resolveUser(phoneNumber, whatsappName);
  if (await handlePendingPin({ phoneNumber, user, text })) return;

  const normalized = String(text || '').trim().toLowerCase();

  // 'hi'/'hello' deliberately fall through to sendam-ai below instead of a
  // static reply here — GREETING now gets a tone-matched response instead of
  // one fixed line every time. 'help'/'menu' stay static: they're an
  // explicit request for the command list, not a greeting.
  if (['help', 'menu'].includes(normalized)) {
    await sendTextMessage(phoneNumber, 'SendAm can help with send money, receive money, balance, escrow, nearby cash-out, contacts, transaction history, and receipts.');
    return;
  }

  if (normalized.includes('balance')) {
    const wallet = await walletService.createOrGetWallet({ user });
    const balance = await walletService.balance({ wallet });
    await sendTextMessage(phoneNumber, `Your SendAm balance is ${balance.value || balance.displayValue || 'available in your managed wallet'}.`);
    return;
  }

  if (normalized.includes('receive')) {
    const wallet = await walletService.createOrGetWallet({ user });
    await sendTextMessage(phoneNumber, `Share your phone number to receive money on SendAm. Wallet reference: ${wallet.address || wallet.publicKey}`);
    return;
  }

  if (normalized.includes('history') || normalized.includes('transactions')) {
    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const lines = transactions.map((tx) => `${tx.type}: ${tx.amount} ${tx.asset} - ${tx.status}`);
    await sendTextMessage(phoneNumber, lines.length ? lines.join('\n') : 'No transactions yet.');
    return;
  }

  if (normalized.includes('cash-out') || normalized.includes('cash out') || normalized.includes('nearby')) {
    await sendTextMessage(phoneNumber, 'Nearby cash-out is being routed to verified agents. Please share your area or enable the WhatsApp location flow.');
    return;
  }

  if (normalized.includes('escrow')) {
    await sendTextMessage(phoneNumber, 'Escrow is available for protected payments. Tell me the amount, recipient, and release terms.');
    return;
  }

  let decoded = null;
  try {
    decoded = await sendamAi.decode(text, { userId: user.id });
    await writeAuditLog({
      actorType: 'user',
      actorId: user.id,
      action: 'sendam_ai.decode',
      entityType: 'User',
      entityId: user.id,
      metadata: { request: { text, userId: user.id }, response: decoded },
    });
  } catch (error) {
    // A sendam-ai outage/misconfiguration must not cost the user their
    // message — fall through to the generic help reply below, same as an
    // unrecognized command today.
    logger.warn(`sendam-ai decode failed for ${phoneNumber}: ${error.message}`);
    await writeAuditLog({
      actorType: 'user',
      actorId: user.id,
      action: 'sendam_ai.decode',
      entityType: 'User',
      entityId: user.id,
      metadata: { request: { text, userId: user.id }, error: error.message },
    });
  }

  const greetingReply = resolveGreetingReply(decoded);
  if (greetingReply) {
    await sendTextMessage(phoneNumber, greetingReply);
    return;
  }

  const paymentIntent = mapDecodedIntent(decoded);
  if (paymentIntent) {
    await requestConfirmation({ phoneNumber, user, intent: paymentIntent });
    return;
  }

  await sendTextMessage(phoneNumber, 'I can help you send money, check balance, receive money, start escrow, find cash-out agents, or show receipts.');
};

module.exports = {
  processMessage,
  mapDecodedIntent,
  resolveGreetingReply,
};
