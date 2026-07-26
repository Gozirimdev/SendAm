const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

// custody.client.js requires config/env.js, which throws at require-time if
// DATABASE_URL is unset — same pattern as paymasterClient.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.CUSTODY_SIGNING_SECRET = 'test-secret';
process.env.CUSTODY_TIMEOUT_MS = '2000';

const startServer = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const withClient = async (handler, run) => {
  const server = await startServer(handler);
  process.env.CUSTODY_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/custody/custody.client')];
  const custody = require('../src/custody/custody.client');
  try {
    await run(custody);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const readBody = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
});

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

test('createWallet posts the ref and returns the address', async () => {
  await withClient(
    async (req, res) => {
      assert.equal(req.url, '/wallets');
      const parsed = JSON.parse(await readBody(req));
      assert.deepEqual(parsed, { ref: 'user-1', chain: 'lisk' });
      json(res, 201, { ref: 'user-1', chain: 'lisk', address: '0xabc', created: true });
    },
    async (custody) => {
      const result = await custody.createWallet({ ref: 'user-1' });
      assert.equal(result.address, '0xabc');
      assert.equal(result.created, true);
    },
  );
});

// The signature must cover the exact bytes on the wire. axios would re-serialize
// a plain object by default, producing bytes that don't match what was signed —
// so the client pre-serializes once and signs that.
test('signs the exact body bytes it sends', async () => {
  await withClient(
    async (req, res) => {
      const raw = await readBody(req);
      const expected = crypto.createHmac('sha256', 'test-secret').update(raw).digest('hex');
      assert.equal(req.headers['x-sendam-signature'], expected);
      assert.ok(req.headers['x-sendam-timestamp'], 'timestamp header must be present');
      json(res, 201, { ref: 'user-1', address: '0xabc', created: true });
    },
    async (custody) => {
      await custody.createWallet({ ref: 'user-1' });
    },
  );
});

test('getWallet returns null on 404 rather than throwing', async () => {
  await withClient(
    (req, res) => json(res, 404, { code: 'NOT_FOUND', message: 'No custodied wallet for ref nobody' }),
    async (custody) => {
      assert.equal(await custody.getWallet({ ref: 'nobody' }), null);
    },
  );
});

test('getWallet url-encodes a ref containing a colon', async () => {
  await withClient(
    (req, res) => {
      // The faucet treasury ref is "system:lisk-gas-wallet".
      assert.equal(req.url, '/wallets/system%3Alisk-gas-wallet');
      json(res, 200, { ref: 'system:lisk-gas-wallet', address: '0xtreasury' });
    },
    async (custody) => {
      const result = await custody.getWallet({ ref: 'system:lisk-gas-wallet' });
      assert.equal(result.address, '0xtreasury');
    },
  );
});

test('transfer sends the Idempotency-Key header', async () => {
  await withClient(
    async (req, res) => {
      assert.equal(req.url, '/transfers');
      assert.equal(req.headers['idempotency-key'], 'tx-123');
      const parsed = JSON.parse(await readBody(req));
      assert.equal(parsed.from, '0xfrom');
      assert.equal(parsed.to, '0xto');
      assert.equal(parsed.amount, '5');
      assert.equal(parsed.tokenAddress, '0xtoken');
      json(res, 200, { txHash: '0xhash', explorerUrl: 'https://exp/tx/0xhash' });
    },
    async (custody) => {
      const result = await custody.transfer({
        from: '0xfrom',
        to: '0xto',
        amount: 5,
        tokenAddress: '0xtoken',
        idempotencyKey: 'tx-123',
      });
      assert.equal(result.txHash, '0xhash');
    },
  );
});

// A transfer with no idempotency key would be rejected by the service anyway;
// failing here names the real problem instead of surfacing an opaque 400.
test('transfer refuses to send without an idempotency key', async () => {
  await withClient(
    (req, res) => assert.fail('must not reach the service'),
    async (custody) => {
      await assert.rejects(
        () => custody.transfer({ from: '0xfrom', to: '0xto', amount: 5 }),
        /requires an idempotencyKey/
      );
    },
  );
});

test('transferNative refuses to send without an idempotency key', async () => {
  await withClient(
    (req, res) => assert.fail('must not reach the service'),
    async (custody) => {
      await assert.rejects(
        () => custody.transferNative({ from: '0xfrom', to: '0xto', amountWei: '900' }),
        /requires an idempotencyKey/
      );
    },
  );
});

test('a non-2xx response is surfaced as a descriptive error', async () => {
  await withClient(
    (req, res) => json(res, 400, { code: 'VALIDATION_ERROR', message: '"ref" must be a non-empty string' }),
    async (custody) => {
      await assert.rejects(
        () => custody.createWallet({ ref: '' }),
        /sendam-custody \/wallets failed \(400 VALIDATION_ERROR\)/
      );
    },
  );
});

test('configured() reflects whether base URL and signing secret are both set', async () => {
  const originalUrl = process.env.CUSTODY_BASE_URL;
  delete process.env.CUSTODY_BASE_URL;
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/custody/custody.client')];
  try {
    const custody = require('../src/custody/custody.client');
    assert.equal(custody.configured(), false);
    // And it must refuse to call rather than build a request against undefined.
    await assert.rejects(() => custody.createWallet({ ref: 'user-1' }), /not configured/);
  } finally {
    if (originalUrl) process.env.CUSTODY_BASE_URL = originalUrl;
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/custody/custody.client')];
  }
});
