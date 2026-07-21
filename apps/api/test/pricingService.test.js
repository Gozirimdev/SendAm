const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.EXCHANGERATE_API_KEY = process.env.EXCHANGERATE_API_KEY || 'test-key';

const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

// getExchangeRate calls exchangerate-api directly via axios with a hardcoded
// URL (not injectable through config), so we stub the axios module itself
// rather than spinning up a local server — same require-cache-substitution
// technique as gasTopup.test.js.
const stubAxiosGet = (impl) => stubModule('axios', { get: impl });

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
  stubAxiosGet(async () => { throw new Error('should not be called'); });
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

test('toNaira multiplies the USDC amount by the USDC/NGN rate', async () => {
  let callCount = 0;
  stubAxiosGet(async (url) => {
    callCount += 1;
    assert.match(url, /\/pair\/USDC\/NGN$/);
    return { data: { conversion_rate: 1500 } };
  });
  const pricing = freshPricingService();

  const result = await pricing.toNaira('10');
  assert.equal(result, 15000);
  assert.equal(callCount, 1);
});

test('toNaira caches the rate for repeated calls instead of refetching every time', async () => {
  let callCount = 0;
  stubAxiosGet(async () => {
    callCount += 1;
    return { data: { conversion_rate: 1500 } };
  });
  const pricing = freshPricingService();

  await pricing.toNaira('1');
  await pricing.toNaira('2');
  await pricing.toNaira('3');
  assert.equal(callCount, 1);
});

test('toNaira returns null for a non-numeric amount without making a request', async () => {
  let callCount = 0;
  stubAxiosGet(async () => {
    callCount += 1;
    return { data: { conversion_rate: 1500 } };
  });
  const pricing = freshPricingService();

  assert.equal(await pricing.toNaira('not-a-number'), null);
  assert.equal(callCount, 0);
});

test('toNaira returns null when no exchange rate API key is configured', async () => {
  delete require.cache[require.resolve('../src/config/env')];
  const originalKey = process.env.EXCHANGERATE_API_KEY;
  delete process.env.EXCHANGERATE_API_KEY;
  try {
    stubAxiosGet(async () => { throw new Error('should not be called'); });
    const pricing = freshPricingService();
    assert.equal(await pricing.toNaira('10'), null);
  } finally {
    if (originalKey) process.env.EXCHANGERATE_API_KEY = originalKey;
  }
});
