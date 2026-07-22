const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';

const stubModule = (path, stub) => {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stub };
};

// This tests our glue logic only (challenge stored/cleared, credential
// persisted, errors propagated) — not @simplewebauthn/server's own
// cryptographic attestation verification, which has its own test suite
// upstream. Both the library and prisma are stubbed at the require-cache
// level, same technique as gasTopup.test.js/settlementReconciliation.test.js.
const withStubs = ({ serverLib, prismaStub }, run) => {
  delete require.cache[require.resolve('../src/config/env')];
  stubModule('@simplewebauthn/server', serverLib);
  stubModule('../src/common/prisma', prismaStub);
  delete require.cache[require.resolve('../src/onboarding/webauthn.service')];
  const webauthnService = require('../src/onboarding/webauthn.service');
  return run(webauthnService);
};

test('generateOptions stashes the challenge on the user row and excludes existing credentials', async () => {
  let updateArgs;
  await withStubs(
    {
      serverLib: {
        generateRegistrationOptions: async (opts) => {
          assert.deepEqual(opts.excludeCredentials, [{ id: 'cred-1', transports: ['internal'] }]);
          return { challenge: 'chal-123', rp: {}, user: {} };
        },
      },
      prismaStub: {
        webauthnCredential: {
          findMany: async () => [{ credentialId: 'cred-1', transports: ['internal'] }],
        },
        user: { update: async (args) => { updateArgs = args; } },
      },
    },
    async (webauthnService) => {
      const options = await webauthnService.generateOptions({ id: 'u1', phoneNumber: '+2348000000000' });
      assert.equal(options.challenge, 'chal-123');
      assert.deepEqual(updateArgs, { where: { id: 'u1' }, data: { pendingWebauthnChallenge: 'chal-123' } });
    },
  );
});

test('verifyRegistration persists the credential and clears the challenge on success', async () => {
  let createArgs;
  let clearedChallenge = false;
  await withStubs(
    {
      serverLib: {
        verifyRegistrationResponse: async ({ expectedChallenge }) => {
          assert.equal(expectedChallenge, 'chal-123');
          return {
            verified: true,
            registrationInfo: {
              credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
              credentialDeviceType: 'singleDevice',
              credentialBackedUp: false,
            },
          };
        },
      },
      prismaStub: {
        webauthnCredential: { create: async (args) => { createArgs = args; } },
        user: {
          update: async ({ data }) => {
            if (data.pendingWebauthnChallenge === null) clearedChallenge = true;
          },
        },
      },
    },
    async (webauthnService) => {
      const result = await webauthnService.verifyRegistration({ id: 'u1', pendingWebauthnChallenge: 'chal-123' }, { id: 'attestation-response' });
      assert.deepEqual(result, { verified: true });
      assert.equal(createArgs.data.userId, 'u1');
      assert.equal(createArgs.data.credentialId, 'cred-1');
      assert.equal(createArgs.data.counter, 0n);
      assert.equal(clearedChallenge, true);
    },
  );
});

test('verifyRegistration throws and still clears the challenge when verification fails', async () => {
  let clearedChallenge = false;
  await withStubs(
    {
      serverLib: {
        verifyRegistrationResponse: async () => ({ verified: false }),
      },
      prismaStub: {
        webauthnCredential: { create: async () => { throw new Error('should not be called'); } },
        user: {
          update: async ({ data }) => {
            if (data.pendingWebauthnChallenge === null) clearedChallenge = true;
          },
        },
      },
    },
    async (webauthnService) => {
      await assert.rejects(
        () => webauthnService.verifyRegistration({ id: 'u1', pendingWebauthnChallenge: 'chal-123' }, { id: 'attestation-response' }),
        /could not be verified/
      );
      assert.equal(clearedChallenge, true);
    },
  );
});

test('verifyRegistration throws immediately when no challenge is pending', async () => {
  await withStubs(
    {
      serverLib: { verifyRegistrationResponse: async () => { throw new Error('should not be called'); } },
      prismaStub: { webauthnCredential: {}, user: { update: async () => { throw new Error('should not be called'); } } },
    },
    async (webauthnService) => {
      await assert.rejects(
        () => webauthnService.verifyRegistration({ id: 'u1', pendingWebauthnChallenge: null }, {}),
        /No passkey registration is in progress/
      );
    },
  );
});
