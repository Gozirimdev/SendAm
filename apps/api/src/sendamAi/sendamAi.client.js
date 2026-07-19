const axios = require('axios');
const config = require('../config/env');
const { signRequest } = require('./signing');
const logger = require('../utils/logger');

const configured = () => Boolean(config.sendamAi.baseUrl && config.sendamAi.signingSecret);

const client = () => {
  if (!configured()) {
    throw new Error('sendam-ai is not configured. Set SENDAM_AI_BASE_URL and SENDAM_AI_SIGNING_SECRET.');
  }
  return axios.create({
    baseURL: config.sendamAi.baseUrl.replace(/\/$/, ''),
    // Measured live against the Render deployment: a cold start (free tier
    // spins down after idle) takes ~10s to respond, a warm instance ~2s.
    // Default 30s (config.sendamAi.timeoutMs) leaves headroom for a slower
    // cold start; the one-shot retry below means most requests don't need
    // that full headroom anyway.
    timeout: config.sendamAi.timeoutMs,
  });
};

// A cold start only affects the request that wakes the instance up — by the
// time we retry, it's warm. One retry is enough; a second timeout means
// something other than cold-start latency is wrong, so we give up and let
// the caller fall back.
const MAX_ATTEMPTS = 2;

// We sign the exact string we send. Passing a pre-stringified body (rather
// than a plain object) means axios sends it byte-for-byte untouched, so the
// signature we compute over `rawBody` matches what sendam-ai verifies on the
// other end — axios's default transformRequest would otherwise re-serialize
// a plain object internally, potentially producing different bytes than what
// we signed.
const post = async (path, payload) => {
  const rawBody = JSON.stringify(payload);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const headers = {
      'Content-Type': 'application/json',
      // Signed fresh per attempt: sendam-ai validates timestamp freshness,
      // and a retry can land seconds after the first attempt's timestamp.
      ...signRequest(rawBody, config.sendamAi.signingSecret, Date.now()),
    };
    try {
      const response = await client().post(path, rawBody, { headers });
      return response.data;
    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED';
      if (isTimeout && attempt < MAX_ATTEMPTS) {
        logger.warn(`sendam-ai ${path} timed out on attempt ${attempt}, retrying (likely a cold start)`);
        continue;
      }
      const status = error.response?.status;
      const code = error.response?.data?.code;
      const message = error.response?.data?.message || error.message;
      throw new Error(`sendam-ai ${path} failed${status ? ` (${status}${code ? ` ${code}` : ''})` : ''}: ${message}`);
    }
  }
};

// Classifies free-form chat text into a structured intent. Throws on any
// failure (unconfigured, network error, non-2xx, timeout) — never swallows.
// The caller decides the fallback behavior (this is a proposal, not a
// decision), matching how verifyPin/enforceTransactionPolicy/executePayment
// also throw and are handled one level up in assistant.service.js.
const decode = async (text, { userId } = {}) => {
  const data = await post('/decode', { text, userId });
  return {
    intent: data.intent,
    amount: data.amount,
    asset: data.asset,
    recipient: data.recipient,
    confidence: data.confidence,
    // Only ever non-null for GREETING — a tone-matched, ready-to-send reply.
    // Every other intent leaves this null; the caller supplies its own copy.
    reply: data.reply,
  };
};

module.exports = { decode, configured };
