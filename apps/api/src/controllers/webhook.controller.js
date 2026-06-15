const { processMessage } = require('../services/agent/handler');
const { sendTextMessage } = require('../services/whatsapp.service');
const { replies } = require('../services/agent/replies');
const logger = require('../utils/logger');

/**
 * Transport adapter for the WhatsApp Cloud API webhook. Its only jobs are
 * acknowledging the event quickly, extracting the inbound text message, and
 * handing it to the agent. All conversation logic lives in services/agent.
 *
 * NOTE (security seam, out of scope for this cleanup): POST requests are not
 * yet verified against the X-Hub-Signature-256 header — add that check here
 * before going to mainnet.
 */
const handleIncomingMessage = async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from;
    const whatsappName = value?.contacts?.[0]?.profile?.name || '';

    processMessage(from, whatsappName, message.text.body).catch((err) => {
      logger.error(`Error processing command for ${from}:`, err);
      sendTextMessage(from, replies.genericError(err.message));
    });
  } catch (error) {
    logger.error('Webhook processing error:', error);
  }
};

module.exports = {
  handleIncomingMessage,
};
