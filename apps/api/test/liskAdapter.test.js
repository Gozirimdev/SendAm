const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// config/env.js and services/crypto.service.js both throw at require-time if
// their required env vars are missing/invalid — same pattern as
// sendamAiClient.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
// getTokenBalances reads config.lisk.explorerBaseUrl; give it a value so the
// stubbed-fetch tests exercise the request path rather than the unconfigured guard.
process.env.LISK_EXPLORER_BASE_URL = process.env.LISK_EXPLORER_BASE_URL || 'https://explorer.test';

const liskAdapter = require('../src/wallet/lisk.adapter');
const cryptoService = require('../src/services/crypto.service');

test('createManagedWallet generates a distinct address each time and encrypts the private key', async () => {
  const first = await liskAdapter.createManagedWallet({});
  const second = await liskAdapter.createManagedWallet({});

  assert.match(first.address, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(first.address, second.address);
  assert.equal(first.providerWalletId, first.address);
  // The plaintext key must never appear in the returned payload.
  assert.ok(first.encryptedSecretKey);
  assert.doesNotMatch(first.encryptedSecretKey, /^0x[0-9a-fA-F]{64}$/);
});

test('the encrypted secret key round-trips back to a valid EVM private key', async () => {
  const { ethers } = require('ethers');
  const wallet = await liskAdapter.createManagedWallet({});

  const decrypted = cryptoService.decrypt(wallet.encryptedSecretKey);
  const recovered = new ethers.Wallet(decrypted);

  assert.equal(recovered.address, wallet.address);
});

test('getBalance without LISK_RPC_URL configured fails loudly instead of silently returning zero', async () => {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/wallet/lisk.adapter')];
  const originalRpcUrl = process.env.LISK_RPC_URL;
  delete process.env.LISK_RPC_URL;
  try {
    const freshAdapter = require('../src/wallet/lisk.adapter');
    await assert.rejects(
      () => freshAdapter.getBalance({ address: '0x1111111111111111111111111111111111111111', tokenAddress: '0x2222222222222222222222222222222222222222' }),
      /Lisk RPC is not configured/
    );
  } finally {
    if (originalRpcUrl) process.env.LISK_RPC_URL = originalRpcUrl;
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/wallet/lisk.adapter')];
  }
});

// Blockscout v2 shapes captured live from sepolia-blockscout.lisk.com.
const TOKEN_BALANCES_FIXTURE = [
  { token: { address_hash: '0xAAA', symbol: 'USDC', name: 'USD Coin', decimals: '6', type: 'ERC-20', exchange_rate: '1', reputation: 'ok' }, value: '12500000' },
  { token: { address_hash: '0xBBB', symbol: 'SPAM', name: 'Spam', decimals: '18', type: 'ERC-20', exchange_rate: null, reputation: 'scam' }, value: '999' },
  { token: { address_hash: '0xCCC', symbol: 'ZERO', name: 'Zero', decimals: '18', type: 'ERC-20', exchange_rate: null, reputation: 'ok' }, value: '0' },
  { token: { address_hash: '0xDDD', symbol: 'NFT', name: 'Collectible', decimals: '0', type: 'ERC-721', exchange_rate: null, reputation: 'ok' }, value: '1' },
];
const ACCOUNT_FIXTURE = { coin_balance: '3000000000000000000', exchange_rate: null };

const withStubbedFetch = async (impl, fn) => {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
};

const jsonResponse = (body) => ({ status: 200, text: async () => JSON.stringify(body) });

test('getTokenBalances lists native LSK first, then non-zero ERC-20s, filtering scam and non-ERC-20', async () => {
  const result = await withStubbedFetch(
    async (url) => (url.includes('/token-balances') ? jsonResponse(TOKEN_BALANCES_FIXTURE) : jsonResponse(ACCOUNT_FIXTURE)),
    () => liskAdapter.getTokenBalances({ address: '0x1111111111111111111111111111111111111111' })
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].symbol, 'LSK');
  assert.equal(result[0].native, true);
  assert.equal(result[0].amount, '3.0');
  assert.equal(result[1].symbol, 'USDC');
  assert.equal(result[1].amount, '12.5');
  assert.equal(result[1].usdPrice, 1);
  // SPAM (scam), ZERO (0 balance), and NFT (ERC-721) are all dropped.
  assert.ok(!result.some((t) => ['SPAM', 'ZERO', 'NFT'].includes(t.symbol)));
});

test('getTokenBalances rejects when the explorer is unreachable, so the caller can fall back', async () => {
  await assert.rejects(
    () => withStubbedFetch(
      async () => { throw new Error('network down'); },
      () => liskAdapter.getTokenBalances({ address: '0x1111111111111111111111111111111111111111' })
    ),
    /network down/
  );
});

test('getTokenBalances rejects with a readable error when the explorer returns a non-JSON body', async () => {
  await assert.rejects(
    () => withStubbedFetch(
      async () => ({ status: 429, text: async () => '<!DOCTYPE html><html>rate limited</html>' }),
      () => liskAdapter.getTokenBalances({ address: '0x1111111111111111111111111111111111111111' })
    ),
    /non-JSON body/
  );
});
