const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');

const GRAPH_VERSION = 'v19.0';

const messagesUrl = () =>
  `https://graph.facebook.com/${GRAPH_VERSION}/${config.whatsapp.phoneNumberId}/messages`;

const authHeaders = () => ({
  Authorization: `Bearer ${config.whatsapp.token}`,
  'Content-Type': 'application/json',
});

// True when the Cloud API credentials are present at all. An unset or expired
// token makes every outbound reply vanish silently (postMessage swallows the
// error so a webhook is never failed), which is indistinguishable from the bot
// ignoring the user — so it's surfaced at startup and via /health/whatsapp.
const configured = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);

// Shared POST path. Deliberately does not throw: a WhatsApp API failure must
// not fail an inbound webhook (Meta would retry and redeliver the message).
// Returns null on failure so callers can fall back to another surface.
const postMessage = async (payload, description) => {
  if (!configured()) {
    logger.error(
      `Cannot send WhatsApp ${description}: WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not configured.`
    );
    return null;
  }
  try {
    const response = await axios.post(messagesUrl(), payload, { headers: authHeaders() });
    logger.info(`WhatsApp ${description} sent to ${payload.to}`);
    return response.data;
  } catch (error) {
    logger.error(`WhatsApp API error sending ${description} to ${payload.to}:`, error.response?.data || error.message);
    return null;
  }
};

const sendTextMessage = async (to, body) =>
  postMessage(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    },
    'text message'
  );

/**
 * Sends an interactive Flow message — the button that opens a native form
 * inside WhatsApp. Used for PIN entry so the PIN is never typed into the chat
 * thread; see whatsapp/pinFlow.service.js.
 *
 * `flow_action: navigate` opens directly on `screen` with `screenData`
 * prefilled, saving a round trip versus letting the endpoint serve the first
 * screen via an INIT request.
 */
const sendFlowMessage = async (
  to,
  { flowId, flowToken, cta, bodyText, footerText, screen, screenData }
) =>
  postMessage(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: bodyText },
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: flowToken,
            flow_id: String(flowId),
            flow_cta: cta,
            flow_action: 'navigate',
            flow_action_payload: { screen, data: screenData || {} },
          },
        },
      },
    },
    'flow message'
  );

// Cheap credential probe for /health/whatsapp: reads the phone number node the
// bot sends from. Never returns the token or any other secret.
const checkHealth = async () => {
  if (!configured()) {
    return {
      ok: false,
      error: !config.whatsapp.token
        ? 'WHATSAPP_TOKEN is not set'
        : 'WHATSAPP_PHONE_NUMBER_ID is not set',
    };
  }
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${config.whatsapp.phoneNumberId}`,
      { headers: authHeaders(), params: { fields: 'display_phone_number,verified_name' }, timeout: 15000 }
    );
    return { ok: true, displayPhoneNumber: data.display_phone_number, verifiedName: data.verified_name };
  } catch (error) {
    const detail = error.response?.data?.error?.message || error.message;
    return { ok: false, error: `WhatsApp Cloud API rejected the credentials: ${detail}` };
  }
};

module.exports = {
  sendTextMessage,
  sendFlowMessage,
  configured,
  checkHealth,
};
