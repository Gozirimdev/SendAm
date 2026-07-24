const { test } = require('node:test');
const assert = require('node:assert/strict');

// assistant.service.js requires common/prisma.js, which throws at require-time
// if DATABASE_URL is unset — set a dummy value before importing, same pattern
// crypto.test.js uses for ENCRYPTION_KEY. mapDecodedIntent is a pure function;
// nothing here ever issues a real query.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
// wallet.service.js now requires lisk.adapter.js -> crypto.service.js, which
// also throws at require-time if ENCRYPTION_KEY is unset/wrong length.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || require('node:crypto').randomBytes(32).toString('hex');

const {
  mapDecodedIntent,
  parseSendCommand,
  formatWalletBalance,
  resolveGreetingReply,
  personalizeGreeting,
} = require('../src/whatsapp/assistant.service');

test('maps a valid SEND decode result, defaulting a missing asset to USDC', () => {
  const result = mapDecodedIntent({ intent: 'SEND', amount: '5000', asset: null, recipient: 'ada', confidence: 0.92 });
  assert.deepEqual(result, { amount: '5000', asset: 'USDC', recipient: 'ada' });
});

test('returns null for non-SEND intents (BALANCE, UNKNOWN, etc.)', () => {
  assert.equal(mapDecodedIntent({ intent: 'BALANCE' }), null);
  assert.equal(mapDecodedIntent({ intent: 'UNKNOWN' }), null);
  assert.equal(mapDecodedIntent(null), null);
});

test('rejects a non-numeric or non-positive amount instead of passing it through', () => {
  assert.equal(mapDecodedIntent({ intent: 'SEND', amount: '5k', recipient: 'ada' }), null);
  assert.equal(mapDecodedIntent({ intent: 'SEND', amount: '0', recipient: 'ada' }), null);
  assert.equal(mapDecodedIntent({ intent: 'SEND', amount: '-5', recipient: 'ada' }), null);
});

test('rejects a SEND with no recipient', () => {
  assert.equal(mapDecodedIntent({ intent: 'SEND', amount: '5000', recipient: '' }), null);
});

test('resolveGreetingReply returns sendam-ai\'s tone-matched reply for GREETING', () => {
  const result = resolveGreetingReply({ intent: 'GREETING', reply: 'Ah, e ku aaro! How I fit help you today?' });
  assert.equal(result, 'Ah, e ku aaro! How I fit help you today?');
});

test('resolveGreetingReply falls back to a static line if GREETING carries no reply', () => {
  const result = resolveGreetingReply({ intent: 'GREETING', reply: null });
  assert.match(result, /I can help you send money/);
});

test('resolveGreetingReply returns null for non-GREETING intents', () => {
  assert.equal(resolveGreetingReply({ intent: 'SEND', reply: null }), null);
  assert.equal(resolveGreetingReply({ intent: 'UNKNOWN' }), null);
  assert.equal(resolveGreetingReply(null), null);
});

test('personalizeGreeting addresses the user by name and lowercases the join point', () => {
  assert.equal(
    personalizeGreeting('Hey! Good to hear from you.', 'Ada'),
    'Ada, hey! Good to hear from you.'
  );
});

test('personalizeGreeting returns the reply unchanged with no name or no reply', () => {
  assert.equal(personalizeGreeting('Hey!', null), 'Hey!');
  assert.equal(personalizeGreeting(null, 'Ada'), null);
});

test('parseSendCommand parses "send <amount> to <recipient>", defaulting the asset to USDC', () => {
  assert.deepEqual(parseSendCommand('send 10 to +2348012345678'), {
    amount: '10',
    asset: 'USDC',
    recipient: '+2348012345678',
  });
});

test('parseSendCommand reads an explicit asset and strips thousands separators', () => {
  assert.deepEqual(parseSendCommand('Send 1,500 USDC to ada'), {
    amount: '1500',
    asset: 'USDC',
    recipient: 'ada',
  });
});

test('parseSendCommand returns null for non-send text or a non-positive amount', () => {
  assert.equal(parseSendCommand('what is my balance'), null);
  assert.equal(parseSendCommand('send 0 to ada'), null);
  assert.equal(parseSendCommand('send money to ada'), null);
});

test('formatWalletBalance lists tokens with naira and a total, omitting naira when unknown', () => {
  const message = formatWalletBalance([
    { symbol: 'USDC', amount: '12.5', naira: 17375 },
    { symbol: 'LSK', amount: '3', naira: null },
  ]);
  assert.match(message, /Your SendAm wallet/);
  assert.match(message, /• 12\.5 USDC — ~₦17,375/);
  assert.match(message, /• 3 LSK$/m);
  assert.match(message, /Total: ~₦17,375/);
});

test('formatWalletBalance reports an empty wallet clearly', () => {
  assert.match(formatWalletBalance([]), /empty/i);
});
