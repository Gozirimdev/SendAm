const axios = require('axios');
const config = require('../config/env');
const { signRequest } = require('./signing');

const configured = () => Boolean(config.sendamAi.baseUrl && config.sendamAi.signingSecret);

const client = () => {
  if (!configured()) {
    throw new Error('sendam-ai is not configured. Set SENDAM_AI_BASE_URL and SENDAM_AI_SIGNING_SECRET.');
  }
  return axios.create({
    baseURL: config.sendamAi.baseUrl.replace(/\/$/, ''),
    // Measured live against the Render deployment: a cold start (free tier
    // spins down after idle) takes ~10s to respond, a warm instance ~2s.
    // 15s covers a cold start without stalling a WhatsApp reply forever;
    // still shorter than the 30s used for thirdweb/openfort since this call
    // sits inline in a user-facing reply path, not a "please wait" action.
    timeout: 15000,
  });
};

// We sign the exact string we send. Passing a pre-stringified body (rather
// than a plain object) means axios sends it byte-for-byte untouched, so the
// signature we compute over `rawBody` matches what sendam-ai verifies on the
// other end — axios's default transformRequest would otherwise re-serialize
// a plain object internally, potentially producing different bytes than what
// we signed.
const post = async (path, payload) => {
  const rawBody = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    ...signRequest(rawBody, config.sendamAi.signingSecret, Date.now()),
  };
  try {
    const response = await client().post(path, rawBody, { headers });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    const message = error.response?.data?.message || error.message;
    throw new Error(`sendam-ai ${path} failed${status ? ` (${status}${code ? ` ${code}` : ''})` : ''}: ${message}`);
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
  };
};

module.exports = { decode, configured };
