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

// Cached ~60s so a burst of "balance" messages doesn't hammer exchangerate-api
// on every single one — no Redis in this project, so a plain module-level cache
// is enough (see sendam-mvp-state memory note).
const USD_NGN_RATE_TTL_MS = 60 * 1000;
let cachedUsdNgnRate = null;

// USD -> NGN. Uses a live FX rate when EXCHANGERATE_API_KEY is configured,
// otherwise falls back to the fixed peg (config.pricing.usdNgnFixedRate, 1390).
// Never returns null: displaying an approximate naira value beats showing none.
// To go fully live later, wire a real USD/NGN (and per-token USD) feed here —
// callers don't change.
const getUsdToNairaRate = async () => {
  const now = Date.now();
  if (cachedUsdNgnRate && now - cachedUsdNgnRate.fetchedAt < USD_NGN_RATE_TTL_MS) {
    return cachedUsdNgnRate.rate;
  }
  let rate = null;
  try {
    rate = await getExchangeRate({ sourceCurrency: 'USD', targetCurrency: 'NGN' });
  } catch (error) {
    logger.warn(`USD/NGN rate fetch failed, using fixed peg: ${error.message}`);
  }
  if (!rate) rate = config.pricing.usdNgnFixedRate;
  cachedUsdNgnRate = { rate, fetchedAt: now };
  return rate;
};

// Stablecoins are pegged to ~$1, so we can price them without any market feed.
const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'USDE', 'PYUSD']);
const isStablecoin = (symbol) => STABLECOINS.has(String(symbol || '').toUpperCase());

// Naira value of a token holding: amount × (USD price per token) × USD/NGN.
// The USD price comes from `usdPrice` when the caller has one (e.g. Blockscout's
// exchange_rate), otherwise $1 for stablecoins, otherwise unknown -> null so the
// caller can omit the naira figure rather than invent one.
const tokenToNaira = async ({ amount, usdPrice = null, symbol }) => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) return null;
  const priceUsd = Number.isFinite(Number(usdPrice)) && Number(usdPrice) > 0
    ? Number(usdPrice)
    : (isStablecoin(symbol) ? 1 : null);
  if (priceUsd == null) return null;
  const ngnRate = await getUsdToNairaRate();
  return numericAmount * priceUsd * ngnRate;
};

// Back-compat: the original single-USDC balance path. USDC ≈ $1, so this is
// just tokenToNaira for a USDC amount.
const toNaira = async (usdcAmount) => tokenToNaira({ amount: usdcAmount, symbol: 'USDC' });

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
  toNaira,
  getUsdToNairaRate,
  tokenToNaira,
  isStablecoin,
};
