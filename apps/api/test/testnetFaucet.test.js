const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

const TREASURY = '0x1111111111111111111111111111111111111111';
const USER_WALLET = '0x2222222222222222222222222222222222222222';

const load = ({ lisk = {}, prisma = {}, env = {}, walletService, gasTopup } = {}) => {
  for (const [k, v] of Object.entries({
    LISK_GAS_WALLET_ADDRESS: TREASURY,
    LISK_CHAIN_ID: 'lisk-sepolia',
    TESTNET_FAUCET_ENABLED: 'true',
    TESTNET_FAUCET_AMOUNT: '10',
    ...env,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../src/config/env')];

  stubModule('../src/wallet/lisk.adapter', {
    resolvedChainId: () => 4202,
    getBalance: async () => ({ value: '1000' }),
    sendToken: async () => ({ transactionHash: '0xdrip', explorerUrl: 'https://exp/tx/0xdrip' }),
    ...lisk,
  });
  stubModule('../src/wallet/wallet.service', walletService || { createOrGetWallet: async () => ({ address: USER_WALLET }) });
  stubModule('../src/payment/gasTopup', gasTopup || { ensureGas: async () => ({ toppedUp: true }) });
  stubModule('../src/common/audit.service', { writeAuditLog: async () => {} });
  stubModule('../src/common/prisma', {
    transaction: {
      findFirst: async () => null,
      count: async () => 0,
      create: async (args) => ({ id: 'tx-drip', ...args.data }),
      update: async (args) => args.data,
      ...(prisma.transaction || {}),
    },
  });

  delete require.cache[require.resolve('../src/wallet/testnetFaucet.service')];
  return require('../src/wallet/testnetFaucet.service');
};

const user = { id: 'u1', phoneNumber: '+2348000000000' };

test('dispenses the configured amount and records the drip', async () => {
  let sendArgs;
  let created;
  const faucet = load({
    lisk: { sendToken: async (a) => { sendArgs = a; return { transactionHash: '0xdrip' }; } },
    prisma: { transaction: { create: async (args) => { created = args.data; return { id: 'tx-drip' }; } } },
  });

  const result = await faucet.dispense({ user });
  assert.equal(result.status, 'sent');
  assert.match(result.message, /10 test USDC/);
  assert.equal(sendArgs.fromAddress, TREASURY);
  assert.equal(sendArgs.destination, USER_WALLET);
  assert.equal(sendArgs.amount, '10');
  // Recorded as a transaction, which is both the cooldown source and the
  // audit trail for where treasury funds went.
  assert.equal(created.type, 'faucet_drip');
  assert.equal(created.userId, 'u1');
});

// Handing out tokens on request is a testnet affordance. On mainnet it would
// be an open drain on real funds for anyone who can send a WhatsApp message.
test('refuses to run on a non-testnet chain regardless of the enable flag', async () => {
  const faucet = load({ lisk: { resolvedChainId: () => 1135 } });
  assert.equal(faucet.isTestnet(), false);
  assert.equal(faucet.configured(), false);

  const result = await faucet.dispense({ user });
  assert.equal(result.status, 'unavailable');
});

// LISK_CHAIN_ID is commonly a name, not a number — deriving the chain id from
// raw config gives NaN and silently disables the faucet on the very testnet it
// exists for.
test('resolves a non-numeric LISK_CHAIN_ID via the adapter', async () => {
  const faucet = load({ env: { LISK_CHAIN_ID: 'lisk-sepolia' } });
  assert.equal(faucet.isTestnet(), true);
  assert.equal(faucet.configured(), true);
});

test('is unavailable when no treasury is configured', async () => {
  const faucet = load({ env: { LISK_GAS_WALLET_ADDRESS: undefined, LISK_FAUCET_WALLET_ADDRESS: undefined } });
  assert.equal(faucet.configured(), false);
  assert.match(faucet.unavailableReason(), /LISK_FAUCET_WALLET_ADDRESS|LISK_GAS_WALLET_ADDRESS/);
});

test('enforces the cooldown between claims', async () => {
  const faucet = load({
    prisma: {
      transaction: {
        findFirst: async () => ({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
        count: async () => 1,
        create: async () => assert.fail('must not drip during cooldown'),
      },
    },
  });

  const result = await faucet.dispense({ user });
  assert.equal(result.status, 'cooling_down');
  assert.match(result.message, /22 hours/);
});

test('allows a claim once the cooldown has elapsed', async () => {
  const faucet = load({
    prisma: {
      transaction: {
        findFirst: async () => ({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }),
        count: async () => 1,
      },
    },
  });
  const result = await faucet.dispense({ user });
  assert.equal(result.status, 'sent');
});

test('enforces the lifetime cap per user', async () => {
  const faucet = load({
    prisma: {
      transaction: {
        count: async () => 5,
        create: async () => assert.fail('must not drip past the cap'),
      },
    },
  });
  const result = await faucet.dispense({ user });
  assert.equal(result.status, 'capped');
});

// An empty treasury must report itself rather than fail mid-transfer and leave
// a confusing half-state.
test('reports an empty treasury without attempting a transfer', async () => {
  const faucet = load({
    lisk: {
      getBalance: async () => ({ value: '3' }),
      sendToken: async () => assert.fail('must not transfer from an empty treasury'),
    },
  });
  const result = await faucet.dispense({ user });
  assert.equal(result.status, 'treasury_empty');
});

// The drip is useless if the user can't afford to move it, but a gas failure
// shouldn't block the funds either — they may already have gas.
test('a gas top-up failure does not block the drip', async () => {
  const faucet = load({
    gasTopup: { ensureGas: async () => { throw new Error('gas wallet unreachable'); } },
  });
  const result = await faucet.dispense({ user });
  assert.equal(result.status, 'sent');
});

test('a failed transfer marks the drip failed and never throws', async () => {
  let updated;
  const faucet = load({
    lisk: { sendToken: async () => { throw new Error('execution reverted'); } },
    prisma: { transaction: { update: async (args) => { updated = args.data; return args.data; } } },
  });

  const result = await faucet.dispense({ user });
  assert.equal(result.status, 'failed');
  assert.equal(updated.status, 'failed');
  assert.doesNotMatch(result.message, /execution reverted/);
});
