const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.EXCHANGERATE_API_KEY = process.env.EXCHANGERATE_API_KEY || 'test-key';

const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

const freshPricingService = () => {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/pricing/pricing.service')];
  return require('../src/pricing/pricing.service');
};

test('toMinorUnits converts a decimal USDC amount to a 6-decimal integer string', () => {
  const pricing = freshPricingService();
  assert.equal(pricing.toMinorUnits('5'), '5000000');
  assert.equal(pricing.toMinorUnits('5.5'), '5500000');
  assert.equal(pricing.toMinorUnits('0.000001'), '1');
  assert.equal(pricing.toMinorUnits('123.456789'), '123456789');
});

test('createQuote uses the flat 1% local estimate when settlement is not configured', async () => {
  stubModule('../src/settlement/settlement.client', { configured: () => false });
  stubModule('axios', { get: async () => { throw new Error('should not be called'); } });
  stubModule('../src/common/prisma', {
    quote: { create: async ({ data }) => ({ id: 'q1', ...data }) },
  });
  const pricing = freshPricingService();

  const quote = await pricing.createQuote({ userId: 'u1', sourceCurrency: 'USDC', targetCurrency: 'USDC', sourceAmount: '100', route: 'lisk', provider: 'lisk' });
  assert.equal(quote.fee, '1.00');
});

test('createQuote prefers the settlement quote fee breakdown when configured', async () => {
  stubModule('../src/settlement/settlement.client', {
    configured: () => true,
    quote: async (args) => {
      assert.equal(args.chain, 'lisk');
      assert.equal(args.asset, 'USDC');
      assert.equal(args.netMinorUnits, '100000000');
      return { quoteId: 'sq1', swapFee: '10000', gasEstimate: '5000', margin: '2000' };
    },
  });
  stubModule('../src/common/prisma', {
    quote: { create: async ({ data }) => ({ id: 'q2', ...data }) },
  });
  const pricing = freshPricingService();

  const quote = await pricing.createQuote({ userId: 'u1', sourceCurrency: 'USDC', targetCurrency: 'USDC', sourceAmount: '100', route: 'lisk', provider: 'lisk' });
  // (10000 + 5000 + 2000) minor units = 0.017 USDC
  assert.equal(quote.fee, '0.02');
  assert.deepEqual(quote.metadata, { settlementQuoteId: 'sq1' });
});

test('createQuote falls back to the local estimate when the settlement quote call fails', async () => {
  stubModule('../src/settlement/settlement.client', {
    configured: () => true,
    quote: async () => { throw new Error('sendam-settlement /quote failed (500): boom'); },
  });
  stubModule('../src/common/prisma', {
    quote: { create: async ({ data }) => ({ id: 'q3', ...data }) },
  });
  const pricing = freshPricingService();

  const quote = await pricing.createQuote({ userId: 'u1', sourceCurrency: 'USDC', targetCurrency: 'USDC', sourceAmount: '100', route: 'lisk', provider: 'lisk' });
  assert.equal(quote.fee, '1.00');
  assert.equal(quote.metadata, undefined);
});
