const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.PAYMASTER_SIGNING_SECRET = process.env.PAYMASTER_SIGNING_SECRET || 'test-secret';

// gasTopup.js talks to real modules (lisk.adapter, paymaster.client) — stub
// them at the require-cache level so this stays a fast, network-free unit
// test of the orchestration logic (call paymaster, act on its plan).
const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

const withStubs = ({ lisk, paymaster, gasWalletAddress }, run) => {
  delete require.cache[require.resolve('../src/config/env')];
  if (gasWalletAddress !== undefined) process.env.LISK_GAS_WALLET_ADDRESS = gasWalletAddress;
  else delete process.env.LISK_GAS_WALLET_ADDRESS;

  stubModule('../src/wallet/lisk.adapter', lisk);
  stubModule('../src/paymaster/paymaster.client', paymaster);
  delete require.cache[require.resolve('../src/payment/gasTopup')];
  const { ensureGas } = require('../src/payment/gasTopup');
  return run(ensureGas);
};

test('does nothing when paymaster says the wallet does not need topping up', async () => {
  await withStubs(
    {
      lisk: { getNativeBalance: async () => ({ raw: '5000000000000000000' }) },
      paymaster: {
        configured: () => true,
        planGasTopup: async () => ({ shouldTopUp: false, reason: 'at-or-above-target' }),
      },
      gasWalletAddress: '0xgas',
    },
    async (ensureGas) => {
      const result = await ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-1' });
      assert.deepEqual(result, { toppedUp: false, reason: 'at-or-above-target' });
    },
  );
});

test('executes the top-up plan from the configured platform gas wallet', async () => {
  let sendNativeArgs;
  await withStubs(
    {
      lisk: {
        getNativeBalance: async () => ({ raw: '100' }),
        sendNative: async (args) => {
          sendNativeArgs = args;
          return { transactionHash: '0xtophash' };
        },
      },
      paymaster: {
        configured: () => true,
        planGasTopup: async () => ({ shouldTopUp: true, amountWei: '900', reason: 'below-threshold' }),
      },
      gasWalletAddress: '0xgas',
    },
    async (ensureGas) => {
      const result = await ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-2' });
      assert.deepEqual(result, { toppedUp: true, amountWei: '900', txHash: '0xtophash' });
      assert.deepEqual(sendNativeArgs, { fromAddress: '0xgas', destination: '0xuser', amountWei: '900' });
    },
  );
});

test('throws instead of silently skipping a needed top-up when no gas wallet is configured', async () => {
  await withStubs(
    {
      lisk: { getNativeBalance: async () => ({ raw: '0' }) },
      paymaster: {
        configured: () => true,
        planGasTopup: async () => ({ shouldTopUp: true, amountWei: '900', reason: 'below-threshold' }),
      },
      gasWalletAddress: '',
    },
    async (ensureGas) => {
      await assert.rejects(
        () => ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-3' }),
        /LISK_GAS_WALLET_ADDRESS is not configured/
      );
    },
  );
});

test('skips the check entirely when paymaster is not configured', async () => {
  await withStubs(
    {
      lisk: { getNativeBalance: async () => { throw new Error('should not be called'); } },
      paymaster: { configured: () => false },
      gasWalletAddress: '0xgas',
    },
    async (ensureGas) => {
      const result = await ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-4' });
      assert.deepEqual(result, { toppedUp: false });
    },
  );
});
