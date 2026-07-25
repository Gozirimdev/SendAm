const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.SERVICE_SECRET = process.env.SERVICE_SECRET || crypto.randomBytes(32).toString('hex');
process.env.PIN_PEPPER = 'test-pepper';

const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

const loadSendService = ({ prismaStub, executePaymentStub }) => {
  delete require.cache[require.resolve('../src/config/env')];
  stubModule('../src/common/prisma', prismaStub);
  stubModule('../src/payment/payment.orchestrator', { executePayment: executePaymentStub });
  delete require.cache[require.resolve('../src/whatsapp/send.service')];
  return require('../src/whatsapp/send.service');
};

const { hashPin } = require('../src/compliance/pin.service');
const PIN_HASH = hashPin('1234');

const buildUser = (overrides = {}) => ({
  id: 'u1',
  phoneNumber: '+2348000000000',
  pinHash: PIN_HASH,
  pendingSend: {
    amount: '5',
    asset: 'USDC',
    destination: '0x1111111111111111111111111111111111111111',
    alias: 'Ada',
    routeType: 'domestic',
    requestedAt: new Date(),
    pinAttempts: 0,
  },
  ...overrides,
});

const prismaFor = (user, sink = {}) => ({
  user: {
    findUnique: async () => user,
    update: async (args) => {
      sink.update = args;
      return { ...user, ...args.data };
    },
  },
});

test('a correct PIN executes the payment and reports the receipt', async () => {
  const user = buildUser();
  const sink = {};
  const sendService = loadSendService({
    prismaStub: prismaFor(user, sink),
    executePaymentStub: async () => ({
      transaction: { id: 'tx1', status: 'success' },
      receipt: { transactionId: 'tx1', receiptUrl: 'https://explorer/tx/0xabc' },
    }),
  });

  const result = await sendService.confirmPendingSend({ user, pin: '1234' });
  assert.equal(result.status, 'sent');
  assert.match(result.message, /Sent 5 USDC to Ada/);
  assert.match(result.message, /tx1/);
  // Cleared before execution so a failure can't strand the user in PIN state.
  assert.equal(sink.update.data.pendingSend, null);
});

// The original bug: executePayment threw (KYC, invalid address, RPC down) and
// the throw escaped all the way out of the job, so the user got nothing at all.
test('an execution failure returns a user-facing message instead of throwing', async () => {
  const user = buildUser();
  const sendService = loadSendService({
    prismaStub: prismaFor(user),
    executePaymentStub: async () => {
      throw new Error('KYC approval is required before sending money.');
    },
  });

  const result = await sendService.confirmPendingSend({ user, pin: '1234' });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /isn't verified/);
  // Never leaks the raw error to the user.
  assert.doesNotMatch(result.message, /KYC approval is required/);
});

test('an unrecognised execution failure still produces a safe reply', async () => {
  const user = buildUser();
  const sendService = loadSendService({
    prismaStub: prismaFor(user),
    executePaymentStub: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:8545 at https://rpc.internal/key-abc');
    },
  });

  const result = await sendService.confirmPendingSend({ user, pin: '1234' });
  assert.equal(result.status, 'failed');
  assert.ok(result.message.length > 0);
  assert.doesNotMatch(result.message, /rpc\.internal|ECONNREFUSED/);
});

test('a wrong PIN burns an attempt and reports the tries left', async () => {
  const user = buildUser();
  const sink = {};
  const sendService = loadSendService({
    prismaStub: prismaFor(user, sink),
    executePaymentStub: async () => assert.fail('must not execute on a wrong PIN'),
  });

  const result = await sendService.confirmPendingSend({ user, pin: '9999' });
  assert.equal(result.status, 'wrong_pin');
  assert.match(result.message, /2 tries left/);
  assert.equal(sink.update.data.pendingSend.pinAttempts, 1);
});

test('the final wrong attempt cancels the payment outright', async () => {
  const user = buildUser({
    pendingSend: { ...buildUser().pendingSend, pinAttempts: 2 },
  });
  const sink = {};
  const sendService = loadSendService({
    prismaStub: prismaFor(user, sink),
    executePaymentStub: async () => assert.fail('must not execute on a wrong PIN'),
  });

  const result = await sendService.confirmPendingSend({ user, pin: '9999' });
  assert.equal(result.status, 'locked_out');
  assert.equal(sink.update.data.pendingSend, null);
});

// hashPin throws on anything that isn't 4-6 digits; this used to escape and
// kill the job before the user's PIN was ever checked.
test('a malformed PIN is rejected without throwing and without burning an attempt', async () => {
  const user = buildUser();
  const sink = {};
  const sendService = loadSendService({
    prismaStub: prismaFor(user, sink),
    executePaymentStub: async () => assert.fail('must not execute'),
  });

  for (const bad of ['', '12', 'abcd', '1234567', null]) {
    const result = await sendService.confirmPendingSend({ user, pin: bad });
    assert.equal(result.status, 'malformed_pin', `for ${JSON.stringify(bad)}`);
  }
  assert.equal(sink.update, undefined);
});

test('an expired pending send is cleared and reported, not executed', async () => {
  const user = buildUser({
    pendingSend: {
      ...buildUser().pendingSend,
      requestedAt: new Date(Date.now() - 11 * 60 * 1000),
    },
  });
  const sink = {};
  const sendService = loadSendService({
    prismaStub: prismaFor(user, sink),
    executePaymentStub: async () => assert.fail('must not execute an expired send'),
  });

  const result = await sendService.confirmPendingSend({ user, pin: '1234' });
  assert.equal(result.status, 'expired');
  assert.equal(sink.update.data.pendingSend, null);
});

test('a user with no PIN set is told to finish setup rather than looped', async () => {
  const user = buildUser({ pinHash: null });
  const sendService = loadSendService({
    prismaStub: prismaFor(user),
    executePaymentStub: async () => assert.fail('must not execute'),
  });

  const result = await sendService.confirmPendingSend({ user, pin: '1234' });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /haven't set a payment PIN/);
});

test('confirming with no pending send is a no-op, not a crash', async () => {
  const user = buildUser({ pendingSend: null });
  const sendService = loadSendService({
    prismaStub: prismaFor(user),
    executePaymentStub: async () => assert.fail('must not execute'),
  });

  const result = await sendService.confirmPendingSend({ user, pin: '1234' });
  assert.equal(result.status, 'no_pending');
});
