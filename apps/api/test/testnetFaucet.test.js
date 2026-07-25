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
  // Every env var any test sets must appear here, so each load() resets it.
  // Omitting one lets a value set by an earlier test leak into every later
  // one — which is exactly how the explicit-treasury test silently redirected
  // the empty-treasury assertion at a different address.
  for (const [k, v] of Object.entries({
    LISK_GAS_WALLET_ADDRESS: TREASURY,
    LISK_FAUCET_WALLET_ADDRESS: undefined,
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
    getNativeBalance: async () => ({ value: '1', raw: '1000000000000000000' }),
    sendNative: async () => ({ transactionHash: '0xgas' }),
    createManagedWallet: async () => ({
      providerWalletId: TREASURY,
      address: TREASURY,
      encryptedSecretKey: 'enc',
    }),
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
    wallet: {
      findFirst: async () => ({ address: TREASURY }),
      create: async (args) => ({ id: 'w1', ...args.data }),
      ...(prisma.wallet || {}),
    },
    user: {
      create: async (args) => ({ id: 'sys', ...args.data }),
      findUnique: async () => ({ id: 'sys' }),
      update: async (args) => args.data,
      ...(prisma.user || {}),
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

// Requiring a treasury env var made the feature unreachable for anyone who
// doesn't control the API's environment. It is now provisioned on demand by
// the server, which is the only process that holds ENCRYPTION_KEY and can
// therefore store a key it will actually be able to sign with.
test('works with no treasury env var, provisioning one on first use', async () => {
  let createdWallet;
  const faucet = load({
    env: { LISK_GAS_WALLET_ADDRESS: undefined, LISK_FAUCET_WALLET_ADDRESS: undefined },
    prisma: {
      wallet: {
        findFirst: async () => null, // nothing exists yet
        create: async (args) => { createdWallet = args.data; return { id: 'w1', ...args.data }; },
      },
    },
  });

  assert.equal(faucet.configured(), true, 'must not depend on a treasury env var');

  const { address, created } = await faucet.resolveTreasury();
  assert.equal(created, true);
  assert.equal(address, TREASURY);
  assert.equal(createdWallet.phoneNumber, faucet.SYSTEM_PHONE);
  // Stored encrypted by this process, so it can sign with it later.
  assert.equal(createdWallet.encryptedSecretKey, 'enc');
});

test('reuses an existing treasury rather than minting a second one', async () => {
  const faucet = load({
    env: { LISK_GAS_WALLET_ADDRESS: undefined, LISK_FAUCET_WALLET_ADDRESS: undefined },
    prisma: {
      wallet: {
        findFirst: async () => ({ address: TREASURY }),
        create: async () => assert.fail('must not create a second treasury'),
      },
    },
  });
  const { address, created } = await faucet.resolveTreasury();
  assert.equal(created, false);
  assert.equal(address, TREASURY);
});

// Two people saying "fund me" at once must not end up with two treasuries,
// one of which would silently hold funds nothing pays out of.
test('loses the creation race gracefully instead of minting a duplicate', async () => {
  let walletCreated = false;
  const faucet = load({
    env: { LISK_GAS_WALLET_ADDRESS: undefined, LISK_FAUCET_WALLET_ADDRESS: undefined },
    prisma: {
      wallet: {
        findFirst: (() => {
          let call = 0;
          return async () => (call++ === 0 ? null : { address: TREASURY });
        })(),
        create: async () => { walletCreated = true; return { id: 'w2' }; },
      },
      user: {
        create: async () => { const e = new Error('unique'); e.code = 'P2002'; throw e; },
        findUnique: async () => ({ id: 'sys' }),
      },
    },
  });

  const { address, created } = await faucet.resolveTreasury();
  assert.equal(created, false);
  assert.equal(address, TREASURY);
  assert.equal(walletCreated, false, 'must not write a second treasury wallet');
});

test('an explicit treasury env var still wins', async () => {
  const explicit = '0x3333333333333333333333333333333333333333';
  const faucet = load({
    env: { LISK_FAUCET_WALLET_ADDRESS: explicit },
    prisma: { wallet: { findFirst: async () => assert.fail('must not hit the database') } },
  });
  const { address } = await faucet.resolveTreasury();
  assert.equal(address, explicit);
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
  // A dead end that doesn't say where to send money is what made this feature
  // unusable — the reply must name the address to fund.
  assert.match(result.message, new RegExp(TREASURY));
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
