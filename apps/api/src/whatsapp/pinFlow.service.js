const crypto = require('crypto');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const config = require('../config/env');
const flowCrypto = require('./flow.crypto');
const { sendFlowMessage, sendTextMessage } = require('../services/whatsapp.service');
const { confirmPendingSend, isExpired } = require('./send.service');

// The secure PIN surface: a WhatsApp Flow instead of a chat message.
//
// Today the bot says "reply with your PIN" and the user types it straight into
// the thread, where it is stored forever in both chat histories, in cloud chat
// backups, and on any device that has the conversation open. A Flow replaces
// that with a native form whose contents are encrypted to this backend's public
// key and never enter the conversation at all — the thread only ever shows a
// "payment confirmed" bubble.
//
// The Flow definition itself lives in apps/api/flows/pin-confirm.flow.json and
// is uploaded to Meta once; see docs/whatsapp-pin-flow.md for the setup.

const SCREEN_CONFIRM = 'CONFIRM_PIN';
const SCREEN_SUCCESS = 'SUCCESS';

const configured = () => flowCrypto.configured();

const newFlowToken = () => crypto.randomBytes(24).toString('hex');

const summarise = (pending) =>
  `${pending.amount} ${pending.asset || 'USDC'} to ${pending.alias || pending.destination}`;

// Sends the interactive Flow message that opens the PIN form. Returns false if
// the Flow isn't configured or WhatsApp rejected the message, so the caller can
// fall back to the in-chat PIN prompt rather than leaving the user with nothing.
const sendPinFlow = async ({ phoneNumber, pending }) => {
  if (!configured()) return false;

  const response = await sendFlowMessage(phoneNumber, {
    flowId: config.whatsapp.pinFlowId,
    flowToken: pending.flowToken,
    cta: 'Confirm payment',
    bodyText: `Please confirm this payment:\n${summarise(pending)}`,
    footerText: 'Your PIN is encrypted and never shown in this chat.',
    screen: SCREEN_CONFIRM,
    screenData: { summary: summarise(pending), error_message: ' ' },
  });

  return Boolean(response);
};

// Looks up the pending send a Flow submission belongs to. The flow_token is the
// only credential here — it is server-minted, single-use per payment, and
// unguessable, so it identifies the user without trusting anything the client
// sends.
const findUserByFlowToken = async (flowToken) => {
  if (!flowToken) return null;
  return prisma.user.findFirst({
    where: { pendingSend: { path: ['flowToken'], equals: flowToken } },
  });
};

const errorScreen = (message, summary) => ({
  screen: SCREEN_CONFIRM,
  data: { summary: summary || 'Confirm payment', error_message: message },
});

const successScreen = (message) => ({
  screen: SCREEN_SUCCESS,
  data: { result_message: message },
});

/**
 * Handles one decrypted Flow request. Never throws — a thrown error here would
 * leave the user staring at a spinning form.
 *
 * @param {{action: string, screen?: string, data?: object, flow_token?: string}} payload
 */
const handleDecryptedRequest = async (payload) => {
  const { action, data, flow_token: flowToken } = payload || {};

  // Meta's endpoint health check. Must answer exactly this shape or the Flow
  // is marked unhealthy and stops being deliverable.
  if (action === 'ping') {
    return { data: { status: 'active' } };
  }

  // Client-side error report (e.g. the form failed to render). Log and ack.
  if (data?.error) {
    logger.warn(`WhatsApp Flow client error: ${JSON.stringify(data.error).slice(0, 300)}`);
    return { data: { acknowledged: true } };
  }

  const user = await findUserByFlowToken(flowToken);
  if (!user) {
    return errorScreen('This payment request is no longer active. Please start again in the chat.');
  }
  const pending = user.pendingSend;

  if (action === 'INIT') {
    if (isExpired(pending)) {
      return errorScreen('This payment request expired. Please start again in the chat.');
    }
    return { screen: SCREEN_CONFIRM, data: { summary: summarise(pending), error_message: ' ' } };
  }

  if (action !== 'data_exchange') {
    return errorScreen('Something went wrong. Please start again in the chat.');
  }

  const result = await confirmPendingSend({ user, pin: data?.pin });

  // Wrong PIN / malformed PIN: keep the user on the form so they can retry
  // without leaving WhatsApp, and without the attempt ever touching the chat.
  if (result.status === 'wrong_pin' || result.status === 'malformed_pin') {
    return errorScreen(result.message, summarise(pending));
  }

  // Everything else is terminal. Also mirror the outcome into the chat thread
  // so there's a durable record the user can scroll back to — the Flow's own
  // success screen disappears as soon as it's dismissed.
  await sendTextMessage(user.phoneNumber, result.message);
  return successScreen(result.message);
};

module.exports = {
  configured,
  newFlowToken,
  sendPinFlow,
  handleDecryptedRequest,
  findUserByFlowToken,
  SCREEN_CONFIRM,
  SCREEN_SUCCESS,
};
