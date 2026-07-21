const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// paymaster.client.js requires config/env.js, which throws at require-time
// if DATABASE_URL is unset — same pattern as sendamAiClient.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.PAYMASTER_SIGNING_SECRET = process.env.PAYMASTER_SIGNING_SECRET || 'test-secret';
process.env.PAYMASTER_TIMEOUT_MS = '2000';

const startServer = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const withClient = async (handler, run) => {
  const server = await startServer(handler);
  process.env.PAYMASTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/paymaster/paymaster.client')];
  const paymaster = require('../src/paymaster/paymaster.client');
  try {
    await run(paymaster);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('planGasTopup posts chain=evm/kind=gas-topup and maps the plan response', async () => {
  await withClient(
    (req, res) => {
      assert.equal(req.url, '/sponsor');
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.chain, 'evm');
        assert.equal(parsed.kind, 'gas-topup');
        assert.deepEqual(parsed.params, { address: '0xabc', currentBalance: '100' });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          chain: 'evm',
          estimatedFee: '900',
          sponsored: false,
          kind: 'gas-topup',
          plan: { shouldTopUp: true, amount: '900', reason: 'below-threshold' },
          note: 'Planning only — EVM top-up submission is not implemented.',
        }));
      });
    },
    async (paymaster) => {
      const result = await paymaster.planGasTopup({ address: '0xabc', currentBalanceWei: '100' });
      assert.deepEqual(result, {
        shouldTopUp: true,
        amountWei: '900',
        reason: 'below-threshold',
        estimatedFee: '900',
      });
    },
  );
});

test('planGasTopup sends an Idempotency-Key header when one is passed', async () => {
  await withClient(
    (req, res) => {
      assert.equal(req.headers['idempotency-key'], 'tx-123');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plan: { shouldTopUp: false, amount: '0', reason: 'at-or-above-target' } }));
    },
    async (paymaster) => {
      const result = await paymaster.planGasTopup({ address: '0xabc', currentBalanceWei: '999', idempotencyKey: 'tx-123' });
      assert.equal(result.shouldTopUp, false);
    },
  );
});

test('a non-2xx response is surfaced as a descriptive error', async () => {
  await withClient(
    (req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'VALIDATION_ERROR', message: '"address" must be a 0x-prefixed 20-byte hex address' }));
    },
    async (paymaster) => {
      await assert.rejects(
        () => paymaster.planGasTopup({ address: 'not-an-address', currentBalanceWei: '0' }),
        /sendam-paymaster \/sponsor failed \(400 VALIDATION_ERROR\)/
      );
    },
  );
});

test('configured() reflects whether base URL and signing secret are both set', async () => {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/paymaster/paymaster.client')];
  const originalUrl = process.env.PAYMASTER_BASE_URL;
  delete process.env.PAYMASTER_BASE_URL;
  try {
    const paymaster = require('../src/paymaster/paymaster.client');
    assert.equal(paymaster.configured(), false);
  } finally {
    if (originalUrl) process.env.PAYMASTER_BASE_URL = originalUrl;
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/paymaster/paymaster.client')];
  }
});
