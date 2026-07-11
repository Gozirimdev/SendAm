const { test } = require('node:test');
const assert = require('node:assert/strict');

// secretStore (pulled in transitively) validates the encryption key at
// require-time, so set it before importing.
process.env.SERVICE_SECRET = 'a'.repeat(64);
process.env.FX_PROVIDER = 'not-a-real-provider';

const { getUsdToNgnRate } = require('../src/services/priceOracle.service');

test('getUsdToNgnRate returns null (not a throw) for an unknown provider', async () => {
  const result = await getUsdToNgnRate();
  assert.equal(result, null);
});
