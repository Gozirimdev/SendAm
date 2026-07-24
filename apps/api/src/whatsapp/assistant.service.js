const crypto = require('crypto');
const walletService = require('../wallet/wallet.service');
const { executePayment } = require('../payment/payment.orchestrator');
const { tokenToNaira } = require('../pricing/pricing.service');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { verifyPin } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const sendamAi = require('../sendamAi/sendamAi.client');
const config = require('../config/env');
const { writeAuditLog } = require('../common/audit.service');

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;
// Matches sendam-ai's default flow token TTL (15 min) — no point outliving
// the token we'd be resuming.
const PENDING_FLOW_TTL_MS = 15 * 60 * 1000;
const COLLECT_NAME_FLOW = 'collect_name';
const GET_STARTED_TTL_MS = 15 * 60 * 1000;
const REGISTRATION_TOKEN_TTL_MS = 30 * 60 * 1000;

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

// Local parse for "send <amount> [ASSET] to <recipient>" so the send flow keeps
// working even when sendam-ai is down. Produces the same intent shape as
// mapDecodedIntent; the AI decode remains the fallback for free-form phrasing.
const SEND_COMMAND_RE = /^send\s+([\d,]+(?:\.\d+)?)\s*([a-zA-Z]{2,6})?\s+to\s+(.+)$/i;
const parseSendCommand = (text) => {
  const match = String(text || '').trim().match(SEND_COMMAND_RE);
  if (!match) return null;
  const rawAmount = match[1].replace(/,/g, '');
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const recipient = match[3].trim();
  if (!recipient) return null;
  return { amount: rawAmount, asset: (match[2] || 'USDC').toUpperCase(), recipient };
};

// Renders a wallet's token balances into a WhatsApp-friendly message. Pure (no
// network/WhatsApp I/O) so it can be unit-tested directly. `entries` is
// [{ symbol, amount, naira }] where naira is a number or null.
const formatWalletBalance = (entries) => {
  if (!entries.length) return 'Your SendAm wallet is empty. Add funds to get started.';
  const fmtAmount = (a) => Number(a).toLocaleString('en-NG', { maximumFractionDigits: 6 });
  const fmtNaira = (n) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
  const lines = entries.map((e) => {
    const naira = e.naira != null ? ` — ~${fmtNaira(e.naira)}` : '';
    return `• ${fmtAmount(e.amount)} ${e.symbol}${naira}`;
  });
  const total = entries.reduce((sum, e) => sum + (e.naira || 0), 0);
  const totalLine = total > 0 ? `\nTotal: ~${fmtNaira(total)}` : '';
  return `Your SendAm wallet\n${lines.join('\n')}${totalLine}`;
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

const NAME_PITCH =
  "Hey! I'm SendAm — send and receive crypto right here on WhatsApp, no exchange or app needed. What should I call you?";

// sendam-ai reads tone but never receives a name, so it can't personalize its
// own GREETING copy — we do that locally by addressing the user before their
// (lowercased) reply, e.g. "Ada, hey! good to hear from you — ...".
const personalizeGreeting = (reply, name) => {
  if (!name || !reply) return reply;
  return `${name}, ${reply.charAt(0).toLowerCase()}${reply.slice(1)}`;
};

// Starts the sendam-ai "collect_name" flow, then stores the token the same
// way requestConfirmation() stores pendingSend: on the User row, resumed on
// the next incoming message via handlePendingFlow. This only ever collects a
// name for personalization — it does not register the user or create a
// wallet (see sendRegistrationLink for that, gated behind an explicit yes).
const startNameCollection = async ({ phoneNumber, user }) => {
  const { token } = await sendamAi.flowStart(
    COLLECT_NAME_FLOW,
    {},
    [{ slot: 'name', type: 'FREE_TEXT', description: 'what the user wants to be called, so replies can address them by name' }]
  );
  await prisma.user.update({
    where: { id: user.id },
    data: { pendingFlow: { flow: COLLECT_NAME_FLOW, token, expiresAt: Date.now() + PENDING_FLOW_TTL_MS } },
  });
  await sendTextMessage(phoneNumber, NAME_PITCH);
};

// Mints a single-use, expiring link to the browser onboarding form
// (apps/landing's /onboard page), which collects terms acceptance + a PIN
// (and an optional passkey) and then, on an explicit "Create Wallet" action,
// provisions the wallet — see
// apps/api/src/onboarding/onboarding.service.js::saveSetup/provisionWallet.
const sendRegistrationLink = async ({ phoneNumber, user }) => {
  const token = crypto.randomBytes(24).toString('hex');
  await prisma.user.update({
    where: { id: user.id },
    data: { registrationToken: token, registrationTokenExpiresAt: new Date(Date.now() + REGISTRATION_TOKEN_TTL_MS) },
  });
  const url = `${config.landing.baseUrl.replace(/\/$/, '')}/onboard?token=${token}`;
  await sendTextMessage(
    phoneNumber,
    `Great! Finish setting up your wallet here (takes under a minute): ${url}\nThis link expires in 30 minutes.`
  );
};

const completeNameCollection = async ({ phoneNumber, user, name }) => {
  if (!name) {
    await sendTextMessage(phoneNumber, "No worries — you can tell me your name anytime by saying hi.");
    return;
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { preferredName: name, awaitingGetStartedUntil: new Date(Date.now() + GET_STARTED_TTL_MS) },
  });
  await sendTextMessage(
    phoneNumber,
    `Nice to meet you, ${name}! Want me to set up your SendAm wallet now, so you can send and receive money right here on WhatsApp? (yes/no)`
  );
};

// Mirrors handlePendingPin's shape: resumes a flow started by
// startNameCollection (or any future flow) against the next message that
// comes in, short-circuiting normal /decode routing while one is in flight.
const handlePendingFlow = async ({ phoneNumber, user, text }) => {
  const pending = user.pendingFlow;
  if (!pending?.token) return false;

  if (Date.now() > pending.expiresAt) {
    await prisma.user.update({ where: { id: user.id }, data: { pendingFlow: null } });
    await sendTextMessage(phoneNumber, "That took a bit long and expired — say hi again and we'll pick up where we left off.");
    return true;
  }

  let result;
  try {
    result = await sendamAi.decodeFollowUp(text, pending.token);
  } catch (error) {
    logger.warn(`sendam-ai flow follow-up failed for ${phoneNumber}: ${error.message}`);
    await prisma.user.update({ where: { id: user.id }, data: { pendingFlow: null } });
    await sendTextMessage(phoneNumber, 'Something went wrong there — say hi again and we\'ll restart.');
    return true;
  }

  if (result.status === 'IN_PROGRESS') {
    await prisma.user.update({
      where: { id: user.id },
      data: { pendingFlow: { flow: result.flow, token: result.token, expiresAt: Date.now() + PENDING_FLOW_TTL_MS } },
    });
    await sendTextMessage(phoneNumber, "Sorry, didn't catch that — what should I call you?");
    return true;
  }

  await prisma.user.update({ where: { id: user.id }, data: { pendingFlow: null } });
  if (result.flow === COLLECT_NAME_FLOW) {
    await completeNameCollection({ phoneNumber, user, name: result.slots?.name });
  }
  return true;
};

const GET_STARTED_YES_WORDS = ['yes', 'yeah', 'yep', 'yea', 'sure', 'ok', 'okay', 'go ahead', "let's go", 'lets go'];
const GET_STARTED_NO_WORDS = ['no', 'nope', 'nah', 'not now', 'later', 'maybe later'];

// Resumes the yes/no prompt sent by completeNameCollection. Deliberately a
// plain local word-match rather than another sendam-ai round trip — this is
// a two-way fork, not free-form text needing intent classification.
const handleGetStartedReply = async ({ phoneNumber, user, text }) => {
  if (!user.awaitingGetStartedUntil) return false;

  if (Date.now() > new Date(user.awaitingGetStartedUntil).getTime()) {
    // Stale prompt — clear it and let the message fall through to normal
    // routing instead of forcing a yes/no reading on an unrelated message.
    await prisma.user.update({ where: { id: user.id }, data: { awaitingGetStartedUntil: null } });
    return false;
  }

  const lowered = String(text).trim().toLowerCase().replace(/[.!]+$/, '');

  if (GET_STARTED_YES_WORDS.includes(lowered)) {
    await prisma.user.update({ where: { id: user.id }, data: { awaitingGetStartedUntil: null } });
    await sendRegistrationLink({ phoneNumber, user });
    return true;
  }

  if (GET_STARTED_NO_WORDS.includes(lowered)) {
    await prisma.user.update({ where: { id: user.id }, data: { awaitingGetStartedUntil: null } });
    await sendTextMessage(phoneNumber, "All good — just say the word whenever you're ready to get set up.");
    return true;
  }

  await sendTextMessage(phoneNumber, 'Just a yes or no works — want me to set up your wallet now?');
  return true;
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
  if (await handlePendingFlow({ phoneNumber, user, text })) return;
  if (await handleGetStartedReply({ phoneNumber, user, text })) return;

  const normalized = String(text || '').trim().toLowerCase();

  // 'hi'/'hello' deliberately fall through to sendam-ai below instead of a
  // static reply here — GREETING now gets a tone-matched response instead of
  // one fixed line every time. 'help'/'menu' stay static: they're an
  // explicit request for the command list, not a greeting.
  if (['help', 'menu'].includes(normalized)) {
    await sendTextMessage(phoneNumber, 'SendAm can help with send money, receive money, balance, my address, escrow, nearby cash-out, contacts, transaction history, and receipts.');
    return;
  }

  if (normalized.includes('balance')) {
    try {
      const wallet = await walletService.createOrGetWallet({ user });
      let entries;
      try {
        const tokens = await walletService.tokenBalances({ wallet });
        entries = await Promise.all(tokens.map(async (t) => ({
          symbol: t.symbol,
          amount: t.amount,
          naira: await tokenToNaira({ amount: t.amount, usdPrice: t.usdPrice, symbol: t.symbol }),
        })));
      } catch (explorerError) {
        // The explorer being down/misconfigured must not cost the user their
        // balance — fall back to the direct on-chain USDC read.
        logger.warn(`Token listing failed for ${phoneNumber}, falling back to USDC read: ${explorerError.message}`);
        const usdc = await walletService.balance({ wallet });
        const value = usdc.value || usdc.displayValue;
        entries = value
          ? [{ symbol: 'USDC', amount: value, naira: await tokenToNaira({ amount: value, symbol: 'USDC' }) }]
          : [];
      }
      await sendTextMessage(phoneNumber, formatWalletBalance(entries));
    } catch (error) {
      // A chain RPC outage/misconfiguration must not leave the user with no
      // reply at all (this is the first place a real Lisk network call
      // happens — wallet creation itself never touches the RPC).
      logger.error(`Balance lookup failed for ${phoneNumber}: ${error.message}`);
      await sendTextMessage(phoneNumber, "Couldn't fetch your balance right now — please try again shortly.");
    }
    return;
  }

  // Checked before `receive` so "receive address" resolves to the address reply.
  if (normalized.includes('address') || normalized === 'wallet') {
    const wallet = await walletService.createOrGetWallet({ user });
    const addr = wallet.address || wallet.publicKey;
    const link = config.lisk.explorerBaseUrl ? `\nView on explorer: ${config.lisk.explorerBaseUrl}/address/${addr}` : '';
    await sendTextMessage(phoneNumber, `Your SendAm wallet address:\n${addr}${link}`);
    return;
  }

  if (normalized.includes('receive')) {
    const wallet = await walletService.createOrGetWallet({ user });
    const addr = wallet.address || wallet.publicKey;
    await sendTextMessage(phoneNumber, `To receive money on SendAm, share your phone number, or give the sender your wallet address:\n${addr}`);
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

  // Explicit "send <amount> to <recipient>" — handled locally so it works even
  // when sendam-ai is unavailable. Free-form phrasing still falls to decode below.
  const localSend = parseSendCommand(text);
  if (localSend) {
    await requestConfirmation({ phoneNumber, user, intent: localSend });
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
    // Every user gets asked their name before anything else — used to
    // personalize replies regardless of whether they ever register a
    // wallet. Registration (see sendRegistrationLink) is a separate,
    // explicitly opt-in step offered once, right after the name is given.
    if (!user.preferredName) {
      try {
        await startNameCollection({ phoneNumber, user });
        return;
      } catch (error) {
        // sendam-ai outage/misconfiguration mid-pitch: fall through to the
        // normal greeting rather than leaving the user with no reply at all.
        logger.warn(`sendam-ai flow/start failed for ${phoneNumber}: ${error.message}`);
      }
    }
    await sendTextMessage(phoneNumber, personalizeGreeting(greetingReply, user.preferredName));
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
  parseSendCommand,
  formatWalletBalance,
  resolveGreetingReply,
  personalizeGreeting,
};
