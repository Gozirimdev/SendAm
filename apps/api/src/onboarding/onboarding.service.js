const prisma = require('../common/prisma');
const walletService = require('../wallet/wallet.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { hashPin } = require('../compliance/pin.service');

// Looks up the user a registration token belongs to, without mutating
// anything — used by the GET the browser form makes on load to prefill the
// name field and confirm the link is still good before showing the form.
// Also the shared re-entry point for every step below: the token, not a
// client-supplied user id, is the only credential this flow ever trusts.
const findByRegistrationToken = async (token) => {
  if (!token) return null;
  const user = await prisma.user.findUnique({ where: { registrationToken: token } });
  if (!user) return null;
  if (user.registrationTokenExpiresAt && Date.now() > new Date(user.registrationTokenExpiresAt).getTime()) {
    return null;
  }
  return user;
};

// Step 1 of the onboarding form: name, terms acceptance, and PIN. Does not
// touch the wallet or WhatsApp — the token stays alive (not burned here) so
// step 2 (provisionWallet) can still use it, and so a passkey registration
// ceremony can happen in between. hashPin enforces the 4-6 digit format
// itself (throws if invalid), so this doesn't duplicate that check.
const saveSetup = async ({ token, name, acceptedTerms, pin }) => {
  const user = await findByRegistrationToken(token);
  if (!user) return null;

  const preferredName = name && name.trim() ? name.trim() : user.preferredName;

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      preferredName,
      termsAcceptedAt: acceptedTerms ? new Date() : user.termsAcceptedAt,
      pinHash: hashPin(pin),
      pinSetAt: new Date(),
    },
  });

  return { user: updated };
};

// Step 2 ("Create Wallet" button): re-checks the token, requires step 1 to
// already be done, then provisions the wallet, burns the token so the link
// can't be replayed, and only now sends the WhatsApp confirmation — the
// notification the user asked for should fire once the wallet actually
// exists, not before.
const provisionWallet = async ({ token }) => {
  const user = await findByRegistrationToken(token);
  if (!user) return null;
  if (!user.termsAcceptedAt || !user.pinHash) {
    throw new Error('Finish setting up your PIN and accepting the terms before creating a wallet.');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      registrationToken: null,
      registrationTokenExpiresAt: null,
    },
  });

  const wallet = await walletService.createOrGetWallet({ user: updated });
  const hasPasskey = Boolean(await prisma.webauthnCredential.findFirst({ where: { userId: updated.id } }));

  await sendTextMessage(
    updated.phoneNumber,
    `You're all set${updated.preferredName ? `, ${updated.preferredName}` : ''}! Your wallet's ready:\n${wallet.address}\n\nPIN set${hasPasskey ? ' and passkey enabled' : ''}. Send "balance" to check your funds, "receive" to get this address again, or just tell me who to send money to.`
  );

  return { user: updated, wallet };
};

module.exports = {
  findByRegistrationToken,
  saveSetup,
  provisionWallet,
};
