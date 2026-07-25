const config = require('../config/env');
const flowCrypto = require('../whatsapp/flow.crypto');
const faucet = require('../wallet/faucet.service');
const whatsappService = require('../services/whatsapp.service');

// One place that answers "is this feature actually going to work, and if not
// why", for every feature whose absence is otherwise silent.
//
// Each of these degrades quietly by design — a missing env var doesn't crash
// the API, it just makes one thing stop happening. That is the right runtime
// behaviour and the wrong operational one: the first signal was a user being
// told the feature wasn't available, with the reason visible only to whoever
// was reading logs at that moment. This surfaces the reason at boot and over
// HTTP instead.
//
// Reasons are written for an operator and name the exact env var to set.

const readiness = () => ({
  whatsapp: whatsappService.configured()
    ? { ready: true }
    : {
        ready: false,
        reason: 'WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not set — every outbound reply is dropped silently.',
      },

  securePinEntry: flowCrypto.configured()
    ? { ready: true }
    : {
        ready: false,
        reason:
          'WHATSAPP_PIN_FLOW_ID / WHATSAPP_FLOW_PRIVATE_KEY are not set — PINs fall back to being typed into the chat thread, where they persist in message history. See docs/whatsapp-pin-flow.md',
      },

  gasTopUp: config.lisk.gasWalletAddress
    ? { ready: true, wallet: config.lisk.gasWalletAddress }
    : {
        ready: false,
        reason:
          'LISK_GAS_WALLET_ADDRESS is not set — new wallets are never funded with ETH, so their first send reverts. Create one with scripts/create-gas-wallet.js',
      },

  // Reports the configured treasury when there is one. Without it the faucet
  // provisions its own on first use, which is a database round trip and so
  // can't be resolved from this synchronous snapshot — say so rather than
  // imply nothing is set up.
  faucet: faucet.configured()
    ? {
        ready: true,
        treasury: faucet.configuredTreasury() || 'auto-provisioned in the database on first "fund me"',
      }
    : {
        ready: false,
        reason: `"fund me" is unavailable: ${faucet.unavailableReason()}.`,
      },
});

// Logged once at boot. Anything not ready is a warning, not an error: these are
// all legitimately optional, and a deployment that has deliberately turned one
// off shouldn't look broken.
const logReadiness = (logger) => {
  const state = readiness();
  const notReady = Object.entries(state).filter(([, v]) => !v.ready);

  if (notReady.length === 0) {
    logger.info('Feature readiness: all features configured.');
    return;
  }

  logger.warn(`Feature readiness: ${notReady.length} of ${Object.keys(state).length} not configured —`);
  for (const [name, { reason }] of notReady) {
    logger.warn(`  [${name}] ${reason}`);
  }
  logger.warn('  Full status at GET /health/features');
};

module.exports = { readiness, logReadiness };
