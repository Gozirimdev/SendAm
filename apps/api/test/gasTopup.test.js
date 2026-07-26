const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.PAYMASTER_SIGNING_SECRET = process.env.PAYMASTER_SIGNING_SECRET || 'test-secret';

// gasTopup.js talks to real modules (chain/lisk.reader, custody.client,
// paymaster.client) — stub them at the require-cache level so this stays a fast,
// network-free unit test of the orchestration logic (call paymaster, act on its
// plan, ask custody to sign).
const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

const withStubs = ({ lisk, custody, paymaster, gasWalletAddress }, run) => {
  delete require.cache[require.resolve('../src/config/env')];
  if (gasWalletAddress !== undefined) process.env.LISK_GAS_WALLET_ADDRESS = gasWalletAddress;
  else delete process.env.LISK_GAS_WALLET_ADDRESS;

  stubModule('../src/chain/lisk.reader', lisk);
  stubModule('../src/custody/custody.client', custody || { transferNative: async () => assert.fail('unexpected transfer') });
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
  let transferArgs;
  await withStubs(
    {
      lisk: {
        // Per-address, so the gas wallet reads as funded — ensureGas checks it
        // can cover the plan before submitting.
        getNativeBalance: async ({ address }) => ({
          raw: address === '0xgas' ? '1000000000000000000' : '100',
        }),
      },
      custody: {
        transferNative: async (args) => {
          transferArgs = args;
          return { txHash: '0xtophash' };
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
      assert.equal(transferArgs.from, '0xgas');
      assert.equal(transferArgs.to, '0xuser');
      assert.equal(transferArgs.amountWei, '900');
    },
  );
});

// The top-up and the payment that triggered it must not share one idempotency
// key, or custody would treat the second as a replay of the first and skip it.
test('namespaces the top-up idempotency key off the caller key', async () => {
  let transferArgs;
  await withStubs(
    {
      lisk: {
        getNativeBalance: async ({ address }) => ({
          raw: address === '0xgas' ? '1000000000000000000' : '100',
        }),
      },
      custody: {
        transferNative: async (args) => {
          transferArgs = args;
          return { txHash: '0xtophash' };
        },
      },
      paymaster: {
        configured: () => true,
        planGasTopup: async () => ({ shouldTopUp: true, amountWei: '900', reason: 'below-threshold' }),
      },
      gasWalletAddress: '0xgas',
    },
    async (ensureGas) => {
      await ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-abc' });
      assert.equal(transferArgs.idempotencyKey, 'tx-abc:gas-topup');
      assert.notEqual(transferArgs.idempotencyKey, 'tx-abc');
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

// Without a paymaster this used to return immediately, so every freshly
// created wallet went to its first send holding zero ETH and reverted. A
// threshold and a target are the whole policy, so a funded gas wallet is
// enough on its own.
test('tops up locally when paymaster is not configured but a gas wallet is', async () => {
  let transferArgs;
  const balances = {
    '0xuser': '0', // empty user wallet
    '0xgas': ethers.parseEther('1').toString(),
  };
  await withStubs(
    {
      lisk: {
        getNativeBalance: async ({ address }) => ({ raw: balances[address] }),
      },
      custody: {
        transferNative: async (args) => {
          transferArgs = args;
          return { txHash: '0xlocalhash' };
        },
      },
      paymaster: { configured: () => false },
      gasWalletAddress: '0xgas',
    },
    async (ensureGas) => {
      const result = await ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-4' });
      assert.equal(result.toppedUp, true);
      // Refilled from 0 up to the configured target, not some fixed drip.
      assert.equal(result.amountWei, ethers.parseEther('0.0002').toString());
      assert.equal(transferArgs.from, '0xgas');
      assert.equal(transferArgs.to, '0xuser');
    },
  );
});

test('leaves a wallet alone when it is already above the local threshold', async () => {
  await withStubs(
    {
      lisk: {
        getNativeBalance: async () => ({ raw: ethers.parseEther('0.001').toString() }),
      },
      custody: { transferNative: async () => assert.fail('must not top up a funded wallet') },
      paymaster: { configured: () => false },
      gasWalletAddress: '0xgas',
    },
    async (ensureGas) => {
      const result = await ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-5' });
      assert.deepEqual(result, { toppedUp: false, reason: 'at-or-above-threshold' });
    },
  );
});

// The most likely reason a correctly-funded user still cannot send, so it must
// name itself rather than fail somewhere downstream.
test('reports precisely when no gas funding is configured at all', async () => {
  await withStubs(
    {
      lisk: { getNativeBalance: async () => assert.fail('must not query without a gas wallet') },
      paymaster: { configured: () => false },
      gasWalletAddress: '',
    },
    async (ensureGas) => {
      const result = await ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-6' });
      assert.deepEqual(result, { toppedUp: false, reason: 'no-gas-funding-configured' });
    },
  );
});

// An empty treasury must say so, not surface as an opaque revert on the
// user's payment.
test('an empty gas wallet reports itself instead of submitting a doomed top-up', async () => {
  const balances = { '0xuser': '0', '0xgas': '1000' };
  await withStubs(
    {
      lisk: {
        getNativeBalance: async ({ address }) => ({ raw: balances[address] }),
      },
      custody: { transferNative: async () => assert.fail('must not submit from an empty gas wallet') },
      paymaster: { configured: () => false },
      gasWalletAddress: '0xgas',
    },
    async (ensureGas) => {
      await assert.rejects(
        () => ensureGas({ wallet: { address: '0xuser' }, idempotencyKey: 'tx-7' }),
        /GAS_WALLET_EMPTY/
      );
    },
  );
});
