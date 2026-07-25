const flowCrypto = require('../whatsapp/flow.crypto');
const pinFlow = require('../whatsapp/pinFlow.service');
const logger = require('../utils/logger');

/**
 * Endpoint for WhatsApp Flow data exchange — where the encrypted PIN arrives.
 *
 * Unlike the message webhook this one must answer *synchronously*: the user is
 * staring at a form waiting for the next screen. The reply is a bare base64
 * string (not JSON) encrypted with the AES key from the request, per Meta's
 * spec.
 *
 * Status codes are part of the contract:
 *   200 — encrypted response body
 *   421 — we could not decrypt; Meta re-fetches our public key and retries
 *   432 — request signature failed (handled by verifyWhatsappSignature)
 *   500 — anything else; Meta shows the user a generic error
 */
const handleFlowRequest = async (req, res) => {
  if (!flowCrypto.configured()) {
    logger.error('Flow endpoint called but WHATSAPP_FLOW_PRIVATE_KEY / WHATSAPP_PIN_FLOW_ID are not configured.');
    return res.sendStatus(500);
  }

  let decrypted;
  try {
    decrypted = flowCrypto.decryptRequest(req.body);
  } catch (error) {
    if (error instanceof flowCrypto.FlowKeyError) {
      logger.error(`Flow request could not be decrypted: ${error.message}`);
      return res.sendStatus(421);
    }
    logger.error(`Malformed Flow request: ${error.message}`);
    return res.sendStatus(500);
  }

  const { payload, aesKey, iv } = decrypted;

  let response;
  try {
    response = await pinFlow.handleDecryptedRequest(payload);
  } catch (error) {
    // handleDecryptedRequest is written not to throw; this is the backstop that
    // keeps a bug there from hanging the user's form forever.
    logger.error(`Flow handler failed for action ${payload?.action}: ${error.message}`);
    response = {
      screen: pinFlow.SCREEN_CONFIRM,
      data: { summary: 'Confirm payment', error_message: 'Something went wrong. Please start again in the chat.' },
    };
  }

  const encrypted = flowCrypto.encryptResponse(response, aesKey, iv);
  res.type('text/plain').status(200).send(encrypted);
};

module.exports = { handleFlowRequest };
