const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

const withStubs = ({ prismaStub, walletServiceStub, sendTextMessageStub }, run) => {
  delete require.cache[require.resolve('../src/config/env')];
  stubModule('../src/common/prisma', prismaStub);
  if (walletServiceStub) stubModule('../src/wallet/wallet.service', walletServiceStub);
  if (sendTextMessageStub) stubModule('../src/services/whatsapp.service', { sendTextMessage: sendTextMessageStub });
  delete require.cache[require.resolve('../src/onboarding/onboarding.service')];
  const onboardingService = require('../src/onboarding/onboarding.service');
  return run(onboardingService);
};

const activeUser = {
  id: 'u1',
  phoneNumber: '+2348000000000',
  preferredName: null,
  registrationToken: 'tok-1',
  registrationTokenExpiresAt: new Date(Date.now() + 60_000),
  termsAcceptedAt: null,
  pinHash: null,
};

test('saveSetup rejects an expired or unknown token', async () => {
  await withStubs(
    { prismaStub: { user: { findUnique: async () => null } } },
    async (onboardingService) => {
      const result = await onboardingService.saveSetup({ token: 'bad-token', name: 'Ada', acceptedTerms: true, pin: '1234' });
      assert.equal(result, null);
    },
  );
});

test('saveSetup saves name, terms acceptance, and a hashed PIN without touching the wallet', async () => {
  let updateArgs;
  await withStubs(
    {
      prismaStub: {
        user: {
          findUnique: async () => activeUser,
          update: async (args) => {
            updateArgs = args;
            return { ...activeUser, ...args.data };
          },
        },
      },
    },
    async (onboardingService) => {
      const result = await onboardingService.saveSetup({ token: 'tok-1', name: 'Ada', acceptedTerms: true, pin: '1234' });
      assert.equal(result.user.preferredName, 'Ada');
      assert.ok(updateArgs.data.termsAcceptedAt instanceof Date);
      assert.ok(updateArgs.data.pinHash);
      assert.notEqual(updateArgs.data.pinHash, '1234'); // hashed, not stored raw
    },
  );
});

test('saveSetup throws for a malformed PIN (hashPin enforces the 4-6 digit format)', async () => {
  await withStubs(
    {
      prismaStub: {
        user: { findUnique: async () => activeUser, update: async () => { throw new Error('should not be called'); } },
      },
    },
    async (onboardingService) => {
      await assert.rejects(
        () => onboardingService.saveSetup({ token: 'tok-1', name: 'Ada', acceptedTerms: true, pin: 'abcd' }),
        /PIN must be 4 to 6 digits/
      );
    },
  );
});

test('provisionWallet rejects an expired or unknown token', async () => {
  await withStubs(
    { prismaStub: { user: { findUnique: async () => null } } },
    async (onboardingService) => {
      const result = await onboardingService.provisionWallet({ token: 'bad-token' });
      assert.equal(result, null);
    },
  );
});

test('provisionWallet rejects when step 1 (terms/PIN) is not complete', async () => {
  await withStubs(
    { prismaStub: { user: { findUnique: async () => activeUser } } },
    async (onboardingService) => {
      await assert.rejects(
        () => onboardingService.provisionWallet({ token: 'tok-1' }),
        /Finish setting up your PIN and accepting the terms/
      );
    },
  );
});

test('provisionWallet creates the wallet, burns the token, and sends a WhatsApp confirmation mentioning the PIN/passkey', async () => {
  const setupUser = { ...activeUser, termsAcceptedAt: new Date(), pinHash: 'hashed', preferredName: 'Ada' };
  let sentMessage;
  await withStubs(
    {
      prismaStub: {
        user: {
          findUnique: async () => setupUser,
          update: async (args) => ({ ...setupUser, ...args.data }),
        },
        webauthnCredential: { findFirst: async () => ({ id: 'cred-1' }) },
      },
      walletServiceStub: { createOrGetWallet: async () => ({ address: '0xabc' }) },
      sendTextMessageStub: async (phoneNumber, message) => { sentMessage = { phoneNumber, message }; },
    },
    async (onboardingService) => {
      const result = await onboardingService.provisionWallet({ token: 'tok-1' });
      assert.equal(result.wallet.address, '0xabc');
      assert.equal(sentMessage.phoneNumber, '+2348000000000');
      assert.match(sentMessage.message, /0xabc/);
      assert.match(sentMessage.message, /passkey enabled/);
    },
  );
});

test('provisionWallet omits "passkey enabled" when no credential was registered', async () => {
  const setupUser = { ...activeUser, termsAcceptedAt: new Date(), pinHash: 'hashed', preferredName: 'Ada' };
  let sentMessage;
  await withStubs(
    {
      prismaStub: {
        user: {
          findUnique: async () => setupUser,
          update: async (args) => ({ ...setupUser, ...args.data }),
        },
        webauthnCredential: { findFirst: async () => null },
      },
      walletServiceStub: { createOrGetWallet: async () => ({ address: '0xabc' }) },
      sendTextMessageStub: async (phoneNumber, message) => { sentMessage = { phoneNumber, message }; },
    },
    async (onboardingService) => {
      await onboardingService.provisionWallet({ token: 'tok-1' });
      assert.doesNotMatch(sentMessage.message, /passkey enabled/);
    },
  );
});
