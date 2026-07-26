const test = require('node:test');
const assert = require('node:assert');

process.env.PIN_PEPPER = process.env.PIN_PEPPER || 'test-pepper';

const { hashPin, verifyPin } = require('../src/compliance/pin.service');

test('verifyPin accepts the correct PIN', () => {
  assert.strictEqual(verifyPin('1234', hashPin('1234')), true);
});

test('verifyPin rejects a wrong PIN of the same length', () => {
  assert.strictEqual(verifyPin('9999', hashPin('1234')), false);
});

// The regression that made the bot go silent: hashPin throws on anything that
// isn't 4-6 digits, and verifyPin used to let that throw escape — unwinding the
// whole inbound-message job so the user never got a reply.
test('verifyPin never throws on malformed input', () => {
  const stored = hashPin('1234');
  for (const bad of ['', ' 1234', '1234 ', '12', '1234567', 'abcd', '12a4', null, undefined, {}, []]) {
    assert.doesNotThrow(() => verifyPin(bad, stored), `threw on ${JSON.stringify(bad)}`);
    assert.strictEqual(verifyPin(bad, stored), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('verifyPin returns false when the user has no PIN set', () => {
  assert.strictEqual(verifyPin('1234', null), false);
  assert.strictEqual(verifyPin('1234', undefined), false);
});

// timingSafeEqual throws on a length mismatch; a truncated or corrupted stored
// hash must be a failed verification, not a crash.
test('verifyPin tolerates a malformed stored hash', () => {
  assert.doesNotThrow(() => verifyPin('1234', 'short'));
  assert.strictEqual(verifyPin('1234', 'short'), false);
});

test('hashPin still rejects malformed PINs loudly', () => {
  assert.throws(() => hashPin('12'), /4 to 6 digits/);
  assert.throws(() => hashPin('abcd'), /4 to 6 digits/);
});

test('hashPin is deterministic and length-preserving', () => {
  assert.strictEqual(hashPin('123456'), hashPin('123456'));
  assert.strictEqual(hashPin('1234').length, 64);
});
