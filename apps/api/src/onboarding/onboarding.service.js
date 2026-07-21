const prisma = require('../common/prisma');
const walletService = require('../wallet/wallet.service');
const { sendTextMessage } = require('../services/whatsapp.service');

// Looks up the user a registration token belongs to, without mutating
// anything — used by the GET the browser form makes on load to prefill the
// name field and confirm the link is still good before showing the form.
const findByRegistrationToken = async (token) => {
  if (!token) return null;
  const user = await prisma.user.findUnique({ where: { registrationToken: token } });
  if (!user) return null;
  if (user.registrationTokenExpiresAt && Date.now() > new Date(user.registrationTokenExpiresAt).getTime()) {
    return null;
  }
  return user;
};

// Called on the onboarding form's submit. Re-validates the token (never
// trusts a client-supplied user id), provisions the wallet, records terms
// acceptance, and burns the token so the link can't be replayed.
const completeRegistration = async ({ token, name }) => {
  const user = await findByRegistrationToken(token);
  if (!user) return null;

  const preferredName = name && name.trim() ? name.trim() : user.preferredName;

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      preferredName,
      termsAcceptedAt: new Date(),
      registrationToken: null,
      registrationTokenExpiresAt: null,
    },
  });

  const wallet = await walletService.createOrGetWallet({ user: updated });

  await sendTextMessage(
    updated.phoneNumber,
    `You're all set${preferredName ? `, ${preferredName}` : ''}! Your wallet's ready:\n${wallet.address}\n\nSend "balance" to check your funds, "receive" to get this address again, or just tell me who to send money to.`
  );

  return { user: updated, wallet };
};

module.exports = {
  findByRegistrationToken,
  completeRegistration,
};
