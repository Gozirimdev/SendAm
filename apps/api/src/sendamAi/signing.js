const crypto = require('crypto');

// Pure HMAC helpers for authenticating requests to sendam-ai. Ported from
// sendam-ai's own reference implementation (signBody/signRequest) so both
// sides compute byte-identical signatures over the exact raw JSON body sent
// on the wire — see sendamAi.client.js for why the body must be
// pre-serialized once and reused verbatim, not re-stringified by axios.
const signBody = (rawBody, secret) => crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

const signRequest = (rawBody, secret, nowMs = Date.now()) => ({
  'x-sendam-signature': signBody(rawBody, secret),
  'x-sendam-timestamp': String(Math.floor(nowMs / 1000)),
});

module.exports = { signBody, signRequest };
