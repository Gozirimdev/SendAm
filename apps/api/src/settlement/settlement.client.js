const axios = require('axios');
const config = require('../config/env');
// sendam-settlement verifies the same x-sendam-signature/x-sendam-timestamp
// HMAC-SHA256-over-raw-body contract as sendam-ai (see sendam-settlement's
// src/lib/hmac.ts) — reusing the existing helper instead of duplicating it.
const { signRequest } = require('../sendamAi/signing');

const configured = () => Boolean(config.settlement.baseUrl && config.settlement.signingSecret);

const client = () => {
  if (!configured()) {
    throw new Error('sendam-settlement is not configured. Set SETTLEMENT_BASE_URL and SETTLEMENT_SIGNING_SECRET.');
  }
  return axios.create({
    baseURL: config.settlement.baseUrl.replace(/\/$/, ''),
    timeout: config.settlement.timeoutMs,
  });
};

// Body is pre-serialized once and signed byte-for-byte — same reasoning as
// sendamAi.client.js / paymaster.client.js.
const request = async (method, path, payload, { idempotencyKey } = {}) => {
  const rawBody = payload === undefined ? '' : JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    ...signRequest(rawBody, config.settlement.signingSecret, Date.now()),
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  try {
    const response = method === 'get'
      ? await client().get(path, { headers })
      : await client().post(path, rawBody, { headers });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    const message = error.response?.data?.message || error.message;
    throw new Error(`sendam-settlement ${path} failed${status ? ` (${status}${code ? ` ${code}` : ''})` : ''}: ${message}`);
  }
};

// Ledger amounts are integer minor units (e.g. USDC's 6 decimals) carried as
// decimal strings on the wire — never floats. `net`/`amount` here must
// already be in minor units; pricing.service.js/payment.orchestrator.js are
// responsible for that conversion before calling this client.
const quote = async ({ chain, asset, netMinorUnits, targetAsset }) => {
  return request('post', '/quote', { chain, asset, net: netMinorUnits, targetAsset });
};

const credit = async ({ userId, chain, asset, amountMinorUnits, idempotencyKey }) => {
  return request('post', '/credit', { userId, chain, asset, amount: amountMinorUnits }, { idempotencyKey });
};

const transfer = async ({ fromUserId, toUserId, asset, amountMinorUnits, idempotencyKey }) => {
  return request('post', '/transfer', { fromUserId, toUserId, asset, amount: amountMinorUnits }, { idempotencyKey });
};

const balancesForUser = async (userId) => {
  const data = await request('get', `/balances/${encodeURIComponent(userId)}`);
  return data.balances;
};

module.exports = { quote, credit, transfer, balancesForUser, configured };
