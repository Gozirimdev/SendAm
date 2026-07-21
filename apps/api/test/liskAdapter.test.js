const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// config/env.js and services/crypto.service.js both throw at require-time if
// their required env vars are missing/invalid — same pattern as
// sendamAiClient.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

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
