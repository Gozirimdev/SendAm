const { test } = require('node:test');
const assert = require('node:assert/strict');

// Set config before requiring the service: crypto.service validates the key at
// require-time, and env.js reads the limit values once on load. Small limits
// keep the assertions easy to reason about.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.MAX_SEND_AMOUNT = '100';
process.env.DAILY_SEND_LIMIT = '200';
process.env.MAX_SENDS_PER_DAY = '3';

const Transaction = require('../src/models/Transaction');
const { enforceSendLimits } = require('../src/services/transaction.service');

// Stub the rolling-window query (Transaction.find(...).select('amount')) with a
// fixed set of prior successful sends, so the guardrail logic can be tested
// without a database.
const stubRecent = (amounts) => {
  Transaction.find = () => ({
    select: async () => amounts.map((amount) => ({ amount: String(amount) })),
  });
};

test('allows a transfer within every limit', async () => {
  stubRecent([]);
  await assert.doesNotReject(enforceSendLimits('user1', 50));
});

test('rejects a transfer above the per-transaction cap', async () => {
  stubRecent([]);
  await assert.rejects(() => enforceSendLimits('user1', 101), /per-transaction limit/);
});

test('rejects once the rolling 24h send count is reached', async () => {
  stubRecent([10, 10, 10]); // 3 prior sends == MAX_SENDS_PER_DAY
  await assert.rejects(() => enforceSendLimits('user1', 10), /count limit/);
});

test('rejects a transfer that would exceed the rolling 24h amount', async () => {
  stubRecent([150]); // already sent 150 of the 200 daily allowance
  await assert.rejects(() => enforceSendLimits('user1', 60), /daily limit/);
});

test('allows a transfer that exactly reaches the daily amount', async () => {
  stubRecent([150]);
  await assert.doesNotReject(enforceSendLimits('user1', 50));
});
