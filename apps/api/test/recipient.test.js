const { test } = require('node:test');
const assert = require('node:assert/strict');

// transaction.service (pulled in transitively by the handler) validates the
// encryption key at require-time, so set it before importing.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { resolveRecipient, isPendingSendExpired } = require('../src/services/agent/handler');

const VALID_KEY = 'GA6UY5O4LMTQLBFXIQXOGM5JK4GNAVXHKYYXKSCIXVHCJ7ETQW55EAAZ';

test('resolves a raw public key directly (uppercased), no alias', () => {
  const result = resolveRecipient({ contacts: [] }, VALID_KEY.toLowerCase());
  assert.equal(result.destination, VALID_KEY);
  assert.equal(result.alias, null);
});

test('resolves a saved alias to its stored public key', () => {
  const user = { contacts: [{ alias: 'ada', publicKey: VALID_KEY }] };
  const result = resolveRecipient(user, 'Ada');
  assert.equal(result.destination, VALID_KEY);
  assert.equal(result.alias, 'ada');
});

test('returns no destination for an unknown alias', () => {
  const result = resolveRecipient({ contacts: [] }, 'nobody');
  assert.equal(result.destination, null);
  assert.equal(result.alias, 'nobody');
});

test('tolerates a user with no contacts array', () => {
  const result = resolveRecipient({}, 'ghost');
  assert.equal(result.destination, null);
  assert.equal(result.alias, 'ghost');
});

test('a pending send with no timestamp is treated as expired', () => {
  assert.equal(isPendingSendExpired({}), true);
});

test('a fresh pending send is not expired; an old one is', () => {
  assert.equal(isPendingSendExpired({ requestedAt: new Date() }), false);
  const old = new Date(Date.now() - 11 * 60 * 1000); // 11 min ago, TTL is 10
  assert.equal(isPendingSendExpired({ requestedAt: old }), true);
});
