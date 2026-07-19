const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { signBody, signRequest } = require('../src/sendamAi/signing');

test('signBody matches a raw HMAC-SHA256 hex digest of the body', () => {
  const secret = 'test-shared-secret';
  const body = JSON.stringify({ text: 'send 5k to ada', userId: 'user_123' });
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(signBody(body, secret), expected);
});

test('signBody matches a golden vector (catches drift from the sendam-ai reference impl)', () => {
  const body = '{"text":"send 5k to ada","userId":"user_123"}';
  assert.equal(
    signBody(body, 'test-shared-secret'),
    'e3cfe48853900ed56108ab9e183ae8697fef3d7bd41c0f433fcb5cf3c75457f1'
  );
});

test('signBody is deterministic and sensitive to a single byte change', () => {
  assert.equal(signBody('{"a":1}', 'k'), signBody('{"a":1}', 'k'));
  assert.notEqual(signBody('{"a":1}', 'k'), signBody('{"a":2}', 'k'));
});

test('signRequest returns lower-case signature/timestamp headers, floored to seconds', () => {
  const body = '{"text":"hi"}';
  const nowMs = 1_700_000_000_123;
  const headers = signRequest(body, 'shared-secret', nowMs);
  assert.deepEqual(Object.keys(headers).sort(), ['x-sendam-signature', 'x-sendam-timestamp']);
  assert.equal(headers['x-sendam-timestamp'], String(Math.floor(nowMs / 1000)));
  assert.equal(headers['x-sendam-signature'], signBody(body, 'shared-secret'));
});
