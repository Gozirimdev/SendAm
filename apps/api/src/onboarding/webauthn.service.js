const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');
const config = require('../config/env');
const prisma = require('../common/prisma');

// Prepares a passkey registration ceremony: builds the options object the
// browser passes to navigator.credentials.create() (via
// @simplewebauthn/browser's startRegistration()), and stashes the
// server-issued challenge on the user row so verifyRegistration can check
// the browser's signed response against it in the second round trip.
const generateOptions = async (user) => {
  const existingCredentials = await prisma.webauthnCredential.findMany({ where: { userId: user.id } });

  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpId,
    userName: user.phoneNumber,
    userDisplayName: user.preferredName || user.phoneNumber,
    userID: new TextEncoder().encode(user.id),
    excludeCredentials: existingCredentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { pendingWebauthnChallenge: options.challenge },
  });

  return options;
};

// Verifies the browser's signed attestation against the challenge stashed by
// generateOptions, then persists the new credential. Always clears the
// pending challenge afterward — a challenge is single-use whether
// verification succeeds or fails, so it's never left around to be replayed.
const verifyRegistration = async (user, response) => {
  const expectedChallenge = user.pendingWebauthnChallenge;
  if (!expectedChallenge) {
    throw new Error('No passkey registration is in progress for this user.');
  }

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.webauthn.origin,
      expectedRPID: config.webauthn.rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('Passkey registration could not be verified.');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await prisma.webauthnCredential.create({
      data: {
        userId: user.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.transports || [],
      },
    });

    return { verified: true };
  } finally {
    await prisma.user.update({ where: { id: user.id }, data: { pendingWebauthnChallenge: null } });
  }
};

module.exports = { generateOptions, verifyRegistration };
