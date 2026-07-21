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

const withStubs = (settlementStub, run) => {
  delete require.cache[require.resolve('../src/config/env')];
  stubModule('../src/settlement/settlement.client', settlementStub);
  delete require.cache[require.resolve('../src/payment/settlementReconciliation')];
  const { recordFeeReconciliation } = require('../src/payment/settlementReconciliation');
  return run(recordFeeReconciliation);
};

test('credits the treasury account for the transaction fee, in minor units', async () => {
  let creditArgs;
  await withStubs(
    {
      configured: () => true,
      credit: async (args) => { creditArgs = args; return { entryId: 'e1' }; },
    },
    async (recordFeeReconciliation) => {
      await recordFeeReconciliation({
        transaction: { id: 'tx1', rail: 'lisk', asset: 'USDC', metadata: { fee: '5.00' } },
      });
      assert.equal(creditArgs.chain, 'lisk');
      assert.equal(creditArgs.asset, 'USDC');
      assert.equal(creditArgs.amountMinorUnits, '5000000');
      assert.equal(creditArgs.idempotencyKey, 'tx1');
    },
  );
});

test('does nothing when settlement is not configured', async () => {
  await withStubs(
    { configured: () => false, credit: async () => { throw new Error('should not be called'); } },
    async (recordFeeReconciliation) => {
      await recordFeeReconciliation({ transaction: { id: 'tx2', rail: 'lisk', asset: 'USDC', metadata: { fee: '5.00' } } });
    },
  );
});

test('does nothing when there is no fee on the transaction', async () => {
  await withStubs(
    { configured: () => true, credit: async () => { throw new Error('should not be called'); } },
    async (recordFeeReconciliation) => {
      await recordFeeReconciliation({ transaction: { id: 'tx3', rail: 'lisk', asset: 'USDC', metadata: {} } });
    },
  );
});

test('never throws when the settlement call fails (logs instead)', async () => {
  await withStubs(
    { configured: () => true, credit: async () => { throw new Error('settlement is down'); } },
    async (recordFeeReconciliation) => {
      await recordFeeReconciliation({ transaction: { id: 'tx4', rail: 'lisk', asset: 'USDC', metadata: { fee: '1.00' } } });
    },
  );
});
