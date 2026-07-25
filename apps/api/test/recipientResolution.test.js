const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.SERVICE_SECRET = process.env.SERVICE_SECRET || crypto.randomBytes(32).toString('hex');

const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

const loadRecipientService = (prismaStub) => {
  stubModule('../src/common/prisma', prismaStub);
  delete require.cache[require.resolve('../src/whatsapp/recipient.service')];
  return require('../src/whatsapp/recipient.service');
};

const emptyPrisma = {
  alias: { findUnique: async () => null },
  contact: { findFirst: async () => null },
  user: { findFirst: async () => null },
};

const sender = { id: 'u1' };
const ADDRESS = '0x742d35cc6634c0532925a3b844bc454e4438f44e';

test('a pasted address resolves to its checksummed form', async () => {
  const service = loadRecipientService(emptyPrisma);
  const result = await service.resolveDestination({ user: sender, recipient: ADDRESS });
  assert.equal(result.ok, true);
  assert.equal(result.destination, '0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
});

// The core bug: "send 5 to 08012345678" used to store the phone number itself
// as the on-chain destination, so ethers threw "invalid address" *after* the
// PIN had been accepted — which the user saw as the bot going silent.
test('a phone number resolves to that user\'s wallet address', async () => {
  let queried;
  const service = loadRecipientService({
    ...emptyPrisma,
    user: {
      findFirst: async (args) => {
        queried = args.where.phoneNumber.in;
        return { id: 'u2', wallet: { address: ADDRESS } };
      },
    },
  });

  const result = await service.resolveDestination({ user: sender, recipient: '08012345678' });
  assert.equal(result.ok, true);
  assert.equal(result.destination, ADDRESS);
  // Looked up under every spelling, so a number stored internationally still
  // matches one typed locally.
  assert.ok(queried.includes('2348012345678'));
  assert.ok(queried.includes('08012345678'));
});

test('an unregistered phone number is explained, not silently accepted', async () => {
  const service = loadRecipientService(emptyPrisma);
  const result = await service.resolveDestination({ user: sender, recipient: '08012345678' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'recipient_not_registered');
  assert.match(service.describeFailure(result), /isn't on SendAm yet/);
});

test('a registered recipient with no wallet is explained', async () => {
  const service = loadRecipientService({
    ...emptyPrisma,
    user: { findFirst: async () => ({ id: 'u2', wallet: null }) },
  });
  const result = await service.resolveDestination({ user: sender, recipient: '08012345678' });
  assert.equal(result.reason, 'recipient_no_wallet');
  assert.match(service.describeFailure(result), /hasn't finished setting up/);
});

test('sending to yourself is refused', async () => {
  const service = loadRecipientService({
    ...emptyPrisma,
    user: { findFirst: async () => ({ id: 'u1', wallet: { address: ADDRESS } }) },
  });
  const result = await service.resolveDestination({ user: sender, recipient: '08012345678' });
  assert.equal(result.reason, 'self_send');
});

test('an alias resolves through to the underlying address and keeps its label', async () => {
  const service = loadRecipientService({
    ...emptyPrisma,
    alias: { findUnique: async () => ({ target: ADDRESS, targetType: 'address' }) },
  });
  const result = await service.resolveDestination({ user: sender, recipient: 'Mum' });
  assert.equal(result.ok, true);
  assert.equal(result.destination, '0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
  assert.equal(result.label, 'Mum');
});

test('an alias pointing at a phone number resolves through both hops', async () => {
  const service = loadRecipientService({
    ...emptyPrisma,
    alias: {
      findUnique: async ({ where }) =>
        where.userId_alias.alias === 'mum' ? { target: '08012345678', targetType: 'phone' } : null,
    },
    user: { findFirst: async () => ({ id: 'u2', wallet: { address: ADDRESS } }) },
  });
  const result = await service.resolveDestination({ user: sender, recipient: 'mum' });
  assert.equal(result.ok, true);
  assert.equal(result.destination, ADDRESS);
});

// A user can create a -> b -> a with two "save as" commands; that must not spin.
test('a cyclic alias chain terminates instead of recursing forever', async () => {
  const service = loadRecipientService({
    ...emptyPrisma,
    alias: {
      findUnique: async ({ where }) => ({
        target: where.userId_alias.alias === 'a' ? 'b' : 'a',
        targetType: 'alias',
      }),
    },
  });
  const result = await service.resolveDestination({ user: sender, recipient: 'a' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_recipient');
});

test('a contact name resolves via its phone number', async () => {
  const service = loadRecipientService({
    ...emptyPrisma,
    contact: {
      findFirst: async ({ where }) =>
        where.displayName.equals.toLowerCase() === 'ada'
          ? { phoneNumber: '08012345678', displayName: 'Ada' }
          : null,
    },
    user: { findFirst: async () => ({ id: 'u2', wallet: { address: ADDRESS } }) },
  });
  const result = await service.resolveDestination({ user: sender, recipient: 'ada' });
  assert.equal(result.ok, true);
  assert.equal(result.destination, ADDRESS);
  assert.equal(result.label, 'Ada');
});

// A contact saved with its own phone number as the display name points at
// itself. Without a depth budget on the contact hop this recurses forever and
// hangs the worker — one message would take the bot down for everyone.
test('a self-referential contact terminates instead of hanging', async () => {
  const service = loadRecipientService({
    ...emptyPrisma,
    contact: { findFirst: async () => ({ phoneNumber: '08012345678', displayName: '08012345678' }) },
    user: { findFirst: async () => null },
  });
  const result = await service.resolveDestination({ user: sender, recipient: '08012345678' });
  assert.equal(result.ok, false);
});

test('an unrecognisable recipient is refused with guidance', async () => {
  const service = loadRecipientService(emptyPrisma);
  const result = await service.resolveDestination({ user: sender, recipient: 'my guy' });
  assert.equal(result.reason, 'unknown_recipient');
  assert.match(service.describeFailure(result), /phone number or a wallet address/);
});
