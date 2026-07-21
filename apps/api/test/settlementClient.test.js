const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// settlement.client.js requires config/env.js, which throws at require-time
// if DATABASE_URL is unset — same pattern as sendamAiClient.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.SETTLEMENT_SIGNING_SECRET = process.env.SETTLEMENT_SIGNING_SECRET || 'test-secret';
process.env.SETTLEMENT_TIMEOUT_MS = '2000';

const startServer = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const withClient = async (handler, run) => {
  const server = await startServer(handler);
  process.env.SETTLEMENT_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/settlement/settlement.client')];
  const settlement = require('../src/settlement/settlement.client');
  try {
    await run(settlement);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const readBody = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body ? JSON.parse(body) : {}));
});

test('quote posts chain/asset/net/targetAsset and returns the fee breakdown', async () => {
  await withClient(
    async (req, res) => {
      assert.equal(req.url, '/quote');
      const parsed = await readBody(req);
      assert.deepEqual(parsed, { chain: 'lisk', asset: 'USDC', net: '5000000', targetAsset: 'NGN' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        quoteId: 'q1', chain: 'lisk', asset: 'USDC', net: '5000000',
        swapFee: '10000', gasEstimate: '5000', margin: '2000', gross: '5017000',
        expiresAt: 123, target: null,
      }));
    },
    async (settlement) => {
      const result = await settlement.quote({ chain: 'lisk', asset: 'USDC', netMinorUnits: '5000000', targetAsset: 'NGN' });
      assert.equal(result.quoteId, 'q1');
      assert.equal(result.gross, '5017000');
    },
  );
});

test('credit requires and forwards an Idempotency-Key header', async () => {
  await withClient(
    async (req, res) => {
      assert.equal(req.headers['idempotency-key'], 'txn-1');
      const parsed = await readBody(req);
      assert.deepEqual(parsed, { userId: 'u1', chain: 'lisk', asset: 'USDC', amount: '5000000' });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entryId: 'e1', replayed: false, balance: '5000000' }));
    },
    async (settlement) => {
      const result = await settlement.credit({ userId: 'u1', chain: 'lisk', asset: 'USDC', amountMinorUnits: '5000000', idempotencyKey: 'txn-1' });
      assert.equal(result.balance, '5000000');
    },
  );
});

test('transfer posts fromUserId/toUserId and returns both sides', async () => {
  await withClient(
    async (req, res) => {
      const parsed = await readBody(req);
      assert.deepEqual(parsed, { fromUserId: 'u1', toUserId: 'u2', asset: 'USDC', amount: '1000000' });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        entryId: 'e2', replayed: false,
        from: { userId: 'u1', balance: '4000000' },
        to: { userId: 'u2', balance: '1000000' },
      }));
    },
    async (settlement) => {
      const result = await settlement.transfer({ fromUserId: 'u1', toUserId: 'u2', asset: 'USDC', amountMinorUnits: '1000000', idempotencyKey: 'txn-2' });
      assert.equal(result.from.balance, '4000000');
      assert.equal(result.to.balance, '1000000');
    },
  );
});

test('balancesForUser GETs /balances/:userId and returns the balances array', async () => {
  await withClient(
    (req, res) => {
      assert.equal(req.url, '/balances/u1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ userId: 'u1', balances: [{ asset: 'USDC', amount: '5000000' }] }));
    },
    async (settlement) => {
      const balances = await settlement.balancesForUser('u1');
      assert.deepEqual(balances, [{ asset: 'USDC', amount: '5000000' }]);
    },
  );
});

test('a non-2xx response is surfaced as a descriptive error', async () => {
  await withClient(
    (req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'INVALID_AMOUNT', message: '"amount" must be positive' }));
    },
    async (settlement) => {
      await assert.rejects(
        () => settlement.credit({ userId: 'u1', chain: 'lisk', asset: 'USDC', amountMinorUnits: '0', idempotencyKey: 'txn-3' }),
        /sendam-settlement \/credit failed \(400 INVALID_AMOUNT\)/
      );
    },
  );
});
