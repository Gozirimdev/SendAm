const axios = require('axios');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const settlementClient = require('../settlement/settlement.client');
const logger = require('../utils/logger');

// sendam-settlement carries money as integer minor units (bigint on its
// side, decimal strings on the wire) — never floats. USDC uses 6 decimals.
const USDC_DECIMALS = 6;
const toMinorUnits = (amount, decimals = USDC_DECIMALS) => {
  const [whole, frac = ''] = String(amount).split('.');
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(paddedFrac || '0')).toString();
};

const getExchangeRate = async ({ sourceCurrency = 'NGN', targetCurrency = 'USDC' }) => {
  if (sourceCurrency === targetCurrency) return 1;

  if (!config.pricing.exchangeRateApiKey) {
    return null;
  }

  const response = await axios.get(`https://v6.exchangerate-api.com/v6/${config.pricing.exchangeRateApiKey}/pair/${sourceCurrency}/${targetCurrency}`, {
    timeout: 15000,
  });
  return response.data?.conversion_rate || null;
};

// sendam-settlement owns the authoritative fee model (swap fee + gas
// estimate + margin, see its LEDGER.md); this is a best-effort upgrade over
// the flat 1% estimate below. Any failure (unconfigured, unsupported chain,
// network error) falls back to the local estimate rather than blocking the
// quote — a slightly-off displayed fee is better than no quote at all.
const settlementFeeEstimate = async ({ sourceCurrency, sourceAmount, route }) => {
  if (!settlementClient.configured()) return null;
  try {
    const result = await settlementClient.quote({
      chain: route,
      asset: sourceCurrency,
      netMinorUnits: toMinorUnits(sourceAmount),
    });
    const fee = BigInt(result.swapFee) + BigInt(result.gasEstimate) + BigInt(result.margin);
    return { quoteId: result.quoteId, feeMinorUnits: fee.toString() };
  } catch (error) {
    logger.warn(`sendam-settlement quote failed, falling back to local fee estimate: ${error.message}`);
    return null;
  }
};

const createQuote = async ({ userId, sourceCurrency = 'NGN', targetCurrency = 'USDC', sourceAmount, route, provider }) => {
  const rate = await getExchangeRate({ sourceCurrency, targetCurrency });
  const numericAmount = Number(sourceAmount);
  const settlementFee = await settlementFeeEstimate({ sourceCurrency, sourceAmount, route });
  const feeAmount = settlementFee
    ? Number(settlementFee.feeMinorUnits) / 10 ** USDC_DECIMALS
    : (Number.isFinite(numericAmount) ? numericAmount * 0.01 : 0);
  const targetAmount = rate && Number.isFinite(numericAmount) ? ((numericAmount - feeAmount) * rate).toFixed(6) : undefined;

  const quote = await prisma.quote.create({
    data: {
    userId,
    sourceCurrency,
    targetCurrency,
    sourceAmount: String(sourceAmount),
    targetAmount,
    rate,
    fee: feeAmount.toFixed(2),
    provider,
    route,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    metadata: settlementFee ? { settlementQuoteId: settlementFee.quoteId } : undefined,
    },
  });
  return withIdAlias(quote);
};

module.exports = {
  createQuote,
  getExchangeRate,
  toMinorUnits,
};
