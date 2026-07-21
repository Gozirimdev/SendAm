const axios = require('axios');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');

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

// Cached ~60s so a burst of "balance" messages doesn't hammer
// exchangerate-api on every single one — no Redis in this project, so a
// plain module-level cache is enough (see sendam-mvp-state memory note).
const USDC_NGN_RATE_TTL_MS = 60 * 1000;
let cachedUsdcNgnRate = null;

const getUsdcToNairaRate = async () => {
  const now = Date.now();
  if (cachedUsdcNgnRate && now - cachedUsdcNgnRate.fetchedAt < USDC_NGN_RATE_TTL_MS) {
    return cachedUsdcNgnRate.rate;
  }
  const rate = await getExchangeRate({ sourceCurrency: 'USDC', targetCurrency: 'NGN' });
  cachedUsdcNgnRate = { rate, fetchedAt: now };
  return rate;
};

// The wallet only ever holds/sends USDC, so a naira display value is just
// USDC amount × the USDC/NGN rate — no separate crypto price feed needed.
const toNaira = async (usdcAmount) => {
  const amount = Number(usdcAmount);
  if (!Number.isFinite(amount)) return null;
  const rate = await getUsdcToNairaRate();
  if (!rate) return null;
  return amount * rate;
};

const createQuote = async ({ userId, sourceCurrency = 'NGN', targetCurrency = 'USDC', sourceAmount, route, provider }) => {
  const rate = await getExchangeRate({ sourceCurrency, targetCurrency });
  const numericAmount = Number(sourceAmount);
  const feeAmount = Number.isFinite(numericAmount) ? numericAmount * 0.01 : 0;
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
    },
  });
  return withIdAlias(quote);
};

module.exports = {
  createQuote,
  getExchangeRate,
  toNaira,
};
