const { ethers } = require('ethers');
const prisma = require('../common/prisma');
const { looksLikePhone, phoneCandidates } = require('../utils/phone');

// Turns whatever the user typed after "to" into a real on-chain destination.
//
// Everything downstream — payment.orchestrator -> account.service#sendToken ->
// lisk.reader's ERC-20 `transfer` — needs a 0x address. Before this module
// existed the raw text was stored as `destination` verbatim, so "send 5 to
// 08012345678" reached ethers as a phone number and threw an unhandled
// "invalid address" *after* the PIN had already been accepted. The user
// experienced that as the bot going silent mid-payment.
//
// Resolving here, at confirmation time, also means the user finds out their
// recipient is unreachable *before* being asked to authorise anything.

// Both aliases and contacts resolve by pointing at another name, so a user can
// build a cycle out of either — alias a -> b -> a, or a contact whose display
// name is its own phone number. Every indirection step is capped by the same
// depth budget; without it, resolution spins forever and takes the worker with
// it.
const MAX_RESOLVE_DEPTH = 3;

const findWalletForPhone = async (raw) => {
  const candidates = phoneCandidates(raw);
  if (!candidates.length) return null;

  // The wallet row carries its own phoneNumber copy, but it's nullable — go
  // through User so a wallet created before that copy existed still resolves.
  const recipientUser = await prisma.user.findFirst({
    where: { phoneNumber: { in: candidates } },
    include: { wallet: true },
  });
  if (!recipientUser) return { registered: false };

  const address = recipientUser.wallet?.address || recipientUser.wallet?.publicKey;
  return { registered: true, address: address || null, user: recipientUser };
};

/**
 * @returns {Promise<{ok: true, destination: string, label: string}
 *                  | {ok: false, reason: string, label: string}>}
 * `reason` is one of: unknown_recipient, recipient_not_registered,
 * recipient_no_wallet, self_send.
 */
const resolveDestination = async ({ user, recipient, depth = 0 }) => {
  const raw = String(recipient ?? '').trim();
  const label = raw;
  if (!raw) return { ok: false, reason: 'unknown_recipient', label };

  // 1. A literal address the user pasted. Normalised to its checksummed form
  //    so the stored destination is always canonical.
  if (ethers.isAddress(raw)) {
    return { ok: true, destination: ethers.getAddress(raw), label: raw };
  }

  // 2 & 3. Indirections: a saved alias ("mum", "landlord"), then a saved
  //    contact matched on display name. Both re-resolve their target rather
  //    than assuming it's a phone number, so either may point at an address, a
  //    phone number, or another name — hence the shared depth budget.
  if (depth < MAX_RESOLVE_DEPTH) {
    const alias = await prisma.alias.findUnique({
      where: { userId_alias: { userId: user.id, alias: raw.toLowerCase() } },
    });
    if (alias?.target) {
      const resolved = await resolveDestination({ user, recipient: alias.target, depth: depth + 1 });
      return { ...resolved, label: raw };
    }

    const contact = await prisma.contact.findFirst({
      where: { ownerId: user.id, displayName: { equals: raw, mode: 'insensitive' } },
    });
    if (contact?.phoneNumber) {
      const resolved = await resolveDestination({ user, recipient: contact.phoneNumber, depth: depth + 1 });
      return { ...resolved, label: contact.displayName || raw };
    }
  }

  // 4. A phone number — the common case. Resolves to that user's wallet.
  if (looksLikePhone(raw)) {
    const match = await findWalletForPhone(raw);
    if (!match || !match.registered) return { ok: false, reason: 'recipient_not_registered', label };
    if (!match.address) return { ok: false, reason: 'recipient_no_wallet', label };
    if (match.user.id === user.id) return { ok: false, reason: 'self_send', label };
    return { ok: true, destination: match.address, label };
  }

  return { ok: false, reason: 'unknown_recipient', label };
};

// User-facing copy for each failure reason. Kept next to the reasons so a new
// reason can't be added without someone noticing there's no message for it.
const describeFailure = ({ reason, label }) => {
  switch (reason) {
    case 'recipient_not_registered':
      return `${label} isn't on SendAm yet. Ask them to message this number to set up a wallet, or give me a wallet address instead.`;
    case 'recipient_no_wallet':
      return `${label} is on SendAm but hasn't finished setting up a wallet yet, so I can't send there.`;
    case 'self_send':
      return "That's your own number — you can't send money to yourself.";
    case 'unknown_recipient':
    default:
      return `I couldn't work out who "${label}" is. Send me their phone number or a wallet address (starting 0x).`;
  }
};

module.exports = {
  resolveDestination,
  describeFailure,
};
