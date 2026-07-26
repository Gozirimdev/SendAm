const axios = require('axios');
const config = require('../config/env');
// sendam-paymaster verifies the same x-sendam-signature/x-sendam-timestamp
// HMAC-SHA256-over-raw-body contract as sendam-ai (see sendam-paymaster's
// src/lib/hmac.ts) — reusing the existing helper instead of duplicating it.
const { signRequest } = require('../sendamAi/signing');

const configured = () => Boolean(config.paymaster.baseUrl && config.paymaster.signingSecret);

const client = () => {
  if (!configured()) {
    throw new Error('sendam-paymaster is not configured. Set PAYMASTER_BASE_URL and PAYMASTER_SIGNING_SECRET.');
  }
  return axios.create({
    baseURL: config.paymaster.baseUrl.replace(/\/$/, ''),
    timeout: config.paymaster.timeoutMs,
  });
};

// Body is pre-serialized once and signed byte-for-byte, same reasoning as
// sendamAi.client.js: axios's default transformRequest would otherwise
// re-serialize a plain object, producing bytes that don't match what we
// signed.
const post = async (path, payload, { idempotencyKey } = {}) => {
  const rawBody = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    ...signRequest(rawBody, config.paymaster.signingSecret, Date.now()),
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  try {
    const response = await client().post(path, rawBody, { headers });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    const message = error.response?.data?.message || error.message;
    throw new Error(`sendam-paymaster ${path} failed${status ? ` (${status}${code ? ` ${code}` : ''})` : ''}: ${message}`);
  }
};

// sendam-paymaster only *plans* an EVM gas top-up — it never submits a
// transaction. `currentBalanceWei` must be the sending wallet's current
// native LSK balance (as a decimal wei string); the caller is responsible
// for actually executing the returned plan (see custody.client.js#transferNative).
const planGasTopup = async ({ address, currentBalanceWei, idempotencyKey }) => {
  const data = await post(
    '/sponsor',
    {
      chain: 'evm',
      kind: 'gas-topup',
      params: { address, currentBalance: currentBalanceWei },
    },
    { idempotencyKey }
  );
  return {
    shouldTopUp: Boolean(data.plan?.shouldTopUp),
    amountWei: data.plan?.amount,
    reason: data.plan?.reason,
    estimatedFee: data.estimatedFee,
  };
};

module.exports = { planGasTopup, configured };
