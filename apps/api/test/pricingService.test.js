const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.EXCHANGERATE_API_KEY = process.env.EXCHANGERATE_API_KEY || 'test-key';

// getExchangeRate calls exchangerate-api directly via axios with a hardcoded
// URL (not injectable through config), so we stub the axios module itself
// rather than spinning up a local server — same require-cache-substitution
// technique as gasTopup.test.js.
const stubAxiosGet = (impl) => {
  const resolved = require.resolve('axios');
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { get: impl } };
};

const freshPricingService = () => {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/pricing/pricing.service')];
  return require('../src/pricing/pricing.service');
};

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
