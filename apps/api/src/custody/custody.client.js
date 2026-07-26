const axios = require('axios');
const config = require('../config/env');
// sendam-custody verifies the same x-sendam-signature/x-sendam-timestamp
// HMAC-SHA256-over-raw-body contract as sendam-ai and sendam-paymaster (see
// sendam-custody's src/lib/hmac.ts) — reusing the existing helper instead of
// duplicating it.
const { signRequest } = require('../sendamAi/signing');

// The boundary this client speaks across is the reason wallet keys are no
// longer in this repo. sendam-custody generates them, holds them encrypted,
// and signs with them; this process only ever learns an address and a
// transaction hash. Nothing here can decrypt anything, because nothing here
// has a key to decrypt with.
const configured = () => Boolean(config.custody.baseUrl && config.custody.signingSecret);

const client = () => {
  if (!configured()) {
    throw new Error('sendam-custody is not configured. Set CUSTODY_BASE_URL and CUSTODY_SIGNING_SECRET.');
  }
  return axios.create({
    baseURL: config.custody.baseUrl.replace(/\/$/, ''),
    timeout: config.custody.timeoutMs,
  });
};

const describeError = (path, error) => {
  const status = error.response?.status;
  const code = error.response?.data?.code;
  const message = error.response?.data?.message || error.message;
  return new Error(
    `sendam-custody ${path} failed${status ? ` (${status}${code ? ` ${code}` : ''})` : ''}: ${message}`
  );
};

// Body is pre-serialized once and signed byte-for-byte, same reasoning as
// paymaster.client.js: axios's default transformRequest would otherwise
// re-serialize a plain object, producing bytes that don't match what we
// signed.
const post = async (path, payload, { idempotencyKey } = {}) => {
  const rawBody = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    ...signRequest(rawBody, config.custody.signingSecret, Date.now()),
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  try {
    const response = await client().post(path, rawBody, { headers });
    return response.data;
  } catch (error) {
    throw describeError(path, error);
  }
};

// GET routes are authenticated too, over an empty body — the service verifies
// the signature before it looks at the method.
const get = async (path) => {
  try {
    const response = await client().get(path, {
      headers: signRequest('', config.custody.signingSecret, Date.now()),
    });
    return response.data;
  } catch (error) {
    throw describeError(path, error);
  }
};

/**
 * The wallet for `ref`, creating it if it doesn't exist yet.
 *
 * Idempotent on `ref` inside the service (a unique constraint is the arbiter
 * of concurrent calls), so this is safe to call on every message rather than
 * only at registration — two requests racing for one user converge on one
 * wallet instead of orphaning funds in a second.
 *
 * @returns {Promise<{ref: string, chain: string, address: string, created: boolean}>}
 */
const createWallet = async ({ ref, chain = 'lisk' }) => post('/wallets', { ref, chain }, { idempotencyKey: `wallet:${ref}` });

/** The wallet for `ref`, or null if it has never been minted. */
const getWallet = async ({ ref }) => {
  try {
    return await get(`/wallets/${encodeURIComponent(ref)}`);
  } catch (error) {
    if (/\(404/.test(error.message)) return null;
    throw error;
  }
};

// `idempotencyKey` is required by the service on both transfer routes: a
// replayed transfer is a double spend, so replay-safety is structural rather
// than something a caller can forget. Pass the Transaction row's id — one
// payment, one key.
const transfer = async ({ from, to, amount, tokenAddress, chain = 'lisk', idempotencyKey }) => {
  if (!idempotencyKey) throw new Error('custody.transfer requires an idempotencyKey.');
  const body = { from, to, amount: String(amount), chain };
  if (tokenAddress) body.tokenAddress = tokenAddress;
  return post('/transfers', body, { idempotencyKey });
};

const transferNative = async ({ from, to, amountWei, chain = 'lisk', idempotencyKey }) => {
  if (!idempotencyKey) throw new Error('custody.transferNative requires an idempotencyKey.');
  return post('/transfers/native', { from, to, amountWei: String(amountWei), chain }, { idempotencyKey });
};

// Unauthenticated on the service side, so this works even when the shared
// secret is misconfigured — which is exactly when you want to ask.
const health = async () => {
  if (!config.custody.baseUrl) return { ok: false, error: 'CUSTODY_BASE_URL is not set' };
  try {
    const response = await axios.get(`${config.custody.baseUrl.replace(/\/$/, '')}/health`, {
      timeout: config.custody.timeoutMs,
    });
    return { ok: response.data?.status === 'ok', ...response.data };
  } catch (error) {
    return { ok: false, error: `custody unreachable: ${error.message}` };
  }
};

module.exports = {
  configured,
  createWallet,
  getWallet,
  transfer,
  transferNative,
  health,
};
