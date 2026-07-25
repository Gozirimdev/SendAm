const walletService = require('../wallet/account.service');
const { selectRail } = require('../blockchain/railSelector');
const { createQuote } = require('../pricing/pricing.service');
const { writeAuditLog } = require('../common/audit.service');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { ensureGas } = require('./gasTopup');
const { recordFeeReconciliation } = require('./settlementReconciliation');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');

const calculateFee = (amount) => {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return '0';
  return (parsed * 0.01).toFixed(2);
};

const buildReceipt = ({ transaction }) => {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    amount: transaction.amount,
    asset: transaction.asset,
    rail: transaction.rail,
    receiptUrl: transaction.explorerUrl,
  };
};

const executePayment = async ({
  sender,
  recipientPhoneNumber,
  destination,
  amount,
  asset = 'USDC',
  sourceCountry = 'NG',
  destinationCountry = 'NG',
  routeType,
  forceRail,
}) => {
  const senderUser = sender;
  if (!senderUser) throw new Error('Sender not found.');

  const rail = selectRail({ sourceCountry, destinationCountry, routeType, forceRail });
  const compliance = await enforceTransactionPolicy({
    user: senderUser,
    amount,
    routeType: routeType || (rail === 'chain' ? 'cross_border' : 'domestic'),
    destinationCountry,
  });
  const wallet = await walletService.createOrGetWallet({ user: senderUser });
  const quote = await createQuote({
    userId: senderUser.id,
    sourceCurrency: asset,
    targetCurrency: asset,
    sourceAmount: amount,
    route: rail,
    provider: rail,
  });

  let transaction = await prisma.transaction.create({
    data: {
      userId: senderUser.id,
      type: routeType === 'escrow' ? 'escrow_create' : 'send',
      amount: String(amount),
      asset,
      recipientPhoneNumber,
      destination,
      rail,
      routeType: routeType || (rail === 'chain' ? 'cross_border' : 'domestic'),
      quoteId: quote.id,
      status: 'processing',
      metadata: {
        fee: calculateFee(amount),
        userHiddenRail: true,
        riskScore: compliance.riskScore,
      },
    },
  });

  try {
    if (rail === 'lisk') {
      // Self-custody has no relayer sponsoring gas — top up the sending
      // wallet's native ETH first, or the transfer below simply reverts.
      await ensureGas({ wallet, idempotencyKey: transaction.id });

      // Check the two independent things that make a transfer fail, so the
      // user is told which one it actually was. On-chain both surface only as
      // a revert string after the fact, and "no USDC to send" and "no ETH to
      // pay gas with" need completely different actions from the user.
      const preflight = await walletService.preflightSend({
        wallet,
        destination,
        amount,
        tokenAddress: config.lisk.usdcContractAddress,
      });
      if (!preflight.ok) {
        const code = preflight.reason === 'insufficient_gas'
          ? 'INSUFFICIENT_GAS_BALANCE'
          : 'INSUFFICIENT_TOKEN_BALANCE';
        throw new Error(
          `${code}: wallet holds ${preflight.have} ${preflight.symbol}, needs ${preflight.need} ${preflight.symbol}`
        );
      }

      const result = await walletService.sendToken({
        wallet,
        chain: config.lisk.chainId,
        destination,
        amount,
        tokenAddress: config.lisk.usdcContractAddress,
      });
      transaction = await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'success',
          providerTransactionId: result.queueId || result.id,
          txHash: result.transactionHash || result.txHash,
        },
      });
      // Fire-and-record: recordFeeReconciliation catches and logs its own
      // errors, so a settlement outage never gates the payment response.
      recordFeeReconciliation({ transaction });
    } else if (rail === 'chain') {
      transaction = await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'pending',
          metadata: {
            ...transaction.metadata,
            corridor: 'chain',
            note: 'chain corridor adapter requires regulated partner or custody configuration before live execution.',
          },
        },
      });
    } else {
      transaction = await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'pending',
          metadata: {
            ...transaction.metadata,
            rampProvider: rail,
            note: 'Fiat ramp provider execution is queued for provider-specific settlement.',
          },
        },
      });
    }

    await writeAuditLog({
      actorType: 'user',
      actorId: String(senderUser.id),
      action: 'payment.executed',
      entityType: 'Transaction',
      entityId: String(transaction.id),
      metadata: { rail, status: transaction.status },
    });

    return { transaction: withIdAlias(transaction), quote, receipt: buildReceipt({ transaction }) };
  } catch (error) {
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'failed',
        metadata: { ...transaction.metadata, error: error.message },
      },
    });
    throw error;
  }
};

module.exports = {
  executePayment,
  calculateFee,
  buildReceipt,
};
