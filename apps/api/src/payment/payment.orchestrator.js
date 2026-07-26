const walletService = require('../account/account.service');
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

  // Whether this is a cross-border payment is a fact about the countries, not
  // about which rail carries it. Deriving it from the countries directly keeps
  // the compliance classification correct now that every rail settles on Lisk,
  // instead of quietly applying domestic limits to a cross-border transfer.
  const effectiveRouteType =
    routeType || (String(sourceCountry).toUpperCase() !== String(destinationCountry).toUpperCase()
      ? 'cross_border'
      : 'domestic');

  const compliance = await enforceTransactionPolicy({
    user: senderUser,
    amount,
    routeType: effectiveRouteType,
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
      routeType: effectiveRouteType,
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
      // Custodied wallets have no relayer sponsoring gas — top up the sending
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

      // The Transaction row's id is the idempotency key custody signs against:
      // one payment, one key, so a retried request can never become a second
      // on-chain transfer.
      const result = await walletService.sendToken({
        wallet,
        destination,
        amount,
        tokenAddress: config.lisk.usdcContractAddress,
        idempotencyKey: transaction.id,
      });
      transaction = await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'success',
          txHash: result.transactionHash,
        },
      });
      // Fire-and-record: recordFeeReconciliation catches and logs its own
      // errors, so a settlement outage never gates the payment response.
      recordFeeReconciliation({ transaction });
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
