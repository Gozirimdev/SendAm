const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// sendamAi.client.js requires config/env.js, which throws at require-time if
// DATABASE_URL is unset — same pattern as assistantIntentMapping.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.SENDAM_AI_SIGNING_SECRET = process.env.SENDAM_AI_SIGNING_SECRET || 'test-secret';
// Real cold starts take seconds; a short fuse here keeps the test fast
// without changing the retry logic under test.
process.env.SENDAM_AI_TIMEOUT_MS = '200';

const startServer = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const withClient = async (handler, run) => {
  const server = await startServer(handler);
  process.env.SENDAM_AI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/sendamAi/sendamAi.client')];
  const sendamAi = require('../src/sendamAi/sendamAi.client');
  try {
    await run(sendamAi);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('decode retries once after a timeout and succeeds on the warm retry', async () => {
  let requestCount = 0;
  await withClient(
    (req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        // Never respond — simulates a cold-start instance that doesn't
        // answer within the client's timeout.
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ intent: 'SEND', amount: '5000', asset: 'USDC', recipient: 'ada', confidence: 0.9, reply: null }));
      });
    },
    async (sendamAi) => {
      const result = await sendamAi.decode('send 5k to ada', { userId: 'u1' });
      assert.deepEqual(result, { intent: 'SEND', amount: '5000', asset: 'USDC', recipient: 'ada', confidence: 0.9, reply: null });
      assert.equal(requestCount, 2);
    },
  );
});

test('decode gives up and throws after two consecutive timeouts', async () => {
  let requestCount = 0;
  await withClient(
    () => {
      requestCount += 1;
      // Never respond, on every attempt.
    },
    async (sendamAi) => {
      await assert.rejects(() => sendamAi.decode('send 5k to ada', { userId: 'u1' }), /sendam-ai \/decode failed/);
      assert.equal(requestCount, 2);
    },
  );
});

