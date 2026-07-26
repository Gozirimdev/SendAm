const custody = require('../custody/custody.client');
const lisk = require('../chain/lisk.reader');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const { withIdAlias, withIdAliases } = require('../common/records');

// Wallet provisioning and movement, as seen from the public API.
//
// This process does not generate keys, hold keys, or sign anything — every one
// of those steps happens in sendam-custody, behind an HMAC boundary. What lives
// here is the mapping from a SendAm user to an address, the read paths (which
// only ever touch public chain data), and the audit trail.

const createOrGetWallet = async ({ user, phoneNumber }) => {
  let owner = user;
  if (!owner) {
    owner = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!owner) owner = await prisma.user.create({ data: { phoneNumber } });
  }

  const existing = await prisma.wallet.findUnique({ where: { userId: owner.id } });
  if (existing) return withIdAlias(existing);

  // Idempotent on `ref` inside custody, so a retry (or a second request racing
  // this one) resolves to the same address rather than minting a second wallet.
  const custodied = await custody.createWallet({ ref: owner.id });

  let wallet;
  try {
    wallet = await prisma.wallet.create({
      data: {
        userId: owner.id,
        phoneNumber: owner.phoneNumber,
        provider: 'custody',
        providerWalletId: custodied.ref,
        address: custodied.address,
        publicKey: custodied.address,
        primaryChain: 'lisk',
        supportedChains: ['lisk'],
        network: 'custody',
      },
    });
  } catch (error) {
    // Wallet.userId is unique. Two messages arriving together (a "balance" and
    // a send, say) both reach this point; custody already gave them the same
    // address, so the loser just reads the winner's row instead of failing the
    // user's request outright.
    if (error.code !== 'P2002') throw error;
    const raced = await prisma.wallet.findUnique({ where: { userId: owner.id } });
    if (!raced) throw error;
    return withIdAlias(raced);
  }

  await prisma.user.update({
    where: { id: owner.id },
    data: { walletId: wallet.id },
  });
  await writeAuditLog({
    actorType: 'system',
    actorId: String(owner.id),
    action: 'wallet.created',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: { provider: wallet.provider, address: wallet.address },
  });

  return withIdAlias(wallet);
};

const getWalletByPhoneNumber = async (phoneNumber) => {
  const wallet = await prisma.wallet.findFirst({ where: { phoneNumber } });
  return withIdAlias(wallet);
};

const addressOf = (wallet) => wallet.address || wallet.publicKey;

const balance = async ({ wallet }) => lisk.getBalance({ address: addressOf(wallet) });

// All tokens the wallet holds (native + ERC-20), for the multi-token balance view.
const tokenBalances = async ({ wallet, limit }) =>
  lisk.getTokenBalances({ address: addressOf(wallet), limit });

// Confirms a transfer can actually succeed before it is submitted — separately
// checking the token balance and the native balance that pays for gas. Runs
// locally against public chain data; custody is only asked once the answer is
// yes, so a doomed send never consumes an idempotency key.
const preflightSend = async ({ wallet, destination, amount, tokenAddress }) =>
  lisk.preflightTransfer({
    fromAddress: addressOf(wallet),
    destination,
    amount,
    tokenAddress,
  });

// `idempotencyKey` is not optional: custody requires one on every transfer so a
// replayed request cannot become a double spend. Callers pass the Transaction
// row's id — one payment, one key.
const sendToken = async ({ wallet, destination, amount, tokenAddress, idempotencyKey }) => {
  const result = await custody.transfer({
    from: addressOf(wallet),
    to: destination,
    amount,
    tokenAddress,
    idempotencyKey,
  });
  // Callers read `transactionHash`; custody speaks `txHash`. Normalise here so
  // the rest of the codebase keeps the field name it already uses.
  return { transactionHash: result.txHash, explorerUrl: result.explorerUrl };
};

const transactionHistory = async ({ userId }) => {
  const history = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return withIdAliases(history);
};

module.exports = {
  createOrGetWallet,
  getWalletByPhoneNumber,
  balance,
  tokenBalances,
  preflightSend,
  sendToken,
  transactionHistory,
};
