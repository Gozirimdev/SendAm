const config = require('../config/env');
const lisk = require('./lisk.adapter');
const thirdweb = require('./thirdweb.adapter');
const openfort = require('./openfort.adapter');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const { withIdAlias, withIdAliases } = require('../common/records');

// Thirdweb Engine was dropped for cost (2026-07-21): wallets are self-custody
// on Lisk now, so this is hardcoded rather than driven by WALLET_PROVIDER —
// a stray/stale env var on any deploy target must not be able to resurrect
// Thirdweb wallet creation.
const providerName = () => 'lisk';
const providers = { lisk, thirdweb, openfort };
const provider = () => providers[providerName()] || lisk;

const walletLabelForPhone = (phoneNumber) => `sendam-${String(phoneNumber).replace(/\D/g, '')}`;

const createOrGetWallet = async ({ user, phoneNumber }) => {
  let owner = user;
  if (!owner) {
    owner = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!owner) owner = await prisma.user.create({ data: { phoneNumber } });
  }

  const existing = await prisma.wallet.findUnique({ where: { userId: owner.id } });
  if (existing) return withIdAlias(existing);

  const managedWallet = await provider().createManagedWallet({
    phoneNumber: owner.phoneNumber,
    label: walletLabelForPhone(owner.phoneNumber),
  });

  const wallet = await prisma.wallet.create({
    data: {
      userId: owner.id,
      phoneNumber: owner.phoneNumber,
      provider: providerName(),
      providerWalletId: managedWallet.providerWalletId,
      address: managedWallet.address,
      publicKey: managedWallet.address,
      encryptedSecretKey: managedWallet.encryptedSecretKey,
      primaryChain: 'lisk',
      supportedChains: ['lisk', 'stellar'],
      network: managedWallet.encryptedSecretKey ? 'self-custody' : 'managed',
    },
  });

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
    metadata: { provider: wallet.provider },
  });

  return withIdAlias(wallet);
};

const getWalletByPhoneNumber = async (phoneNumber) => {
  const wallet = await prisma.wallet.findFirst({ where: { phoneNumber } });
  return withIdAlias(wallet);
};

const balance = async ({ wallet, chain = config.thirdweb.defaultChain }) => {
  return provider().getBalance({ chain, address: wallet.address || wallet.publicKey });
};

// All tokens the wallet holds (native + ERC-20), for the multi-token balance
// view. Only the Lisk adapter implements this; provider() is hardcoded to lisk.
const tokenBalances = async ({ wallet, limit }) => {
  return provider().getTokenBalances({ address: wallet.address || wallet.publicKey, limit });
};

const sendToken = async ({ wallet, chain, destination, amount, tokenAddress }) => {
  return provider().sendToken({
    chain,
    fromAddress: wallet.address || wallet.publicKey,
    destination,
    amount,
    tokenAddress,
  });
};

const transactionHistory = async ({ userId, Transaction }) => {
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
  sendToken,
  transactionHistory,
};
