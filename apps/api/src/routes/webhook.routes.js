const express = require('express');
const router = express.Router();
const verifyWebhook = require('../middlewares/verifyWebhook');
const verifyWhatsappSignature = require('../middlewares/verifyWhatsappSignature');
const webhookController = require('../controllers/webhook.controller');
const flowController = require('../controllers/flow.controller');

// GET for verifying the webhook by WhatsApp
router.get('/', verifyWebhook, (req, res) => {
  res.status(200).send(req.query['hub.challenge']);
});

// POST for receiving messages — signature-checked before any processing.
router.post('/', verifyWhatsappSignature, webhookController.handleIncomingMessage);

// WhatsApp Flow data exchange — the encrypted PIN entry surface. Same
// X-Hub-Signature-256 check as the message webhook: without it, anyone who
// learned the URL could replay a captured Flow body. The payload is encrypted
// on top of that, but the signature is what proves it came from Meta at all.
router.post('/flow', verifyWhatsappSignature, flowController.handleFlowRequest);

module.exports = router;
