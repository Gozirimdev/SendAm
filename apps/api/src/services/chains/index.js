// Chain-adapter registry. Product code (command handlers, guardrails, admin
// reporting) resolves an adapter by name and never imports a chain SDK
// directly — see ARCHITECTURE.md for the interface every adapter implements.
const chainAdapter = require('./chain.reader');
const liskAdapter = require('./lisk.reader');

const SUPPORTED_CHAINS = ['chain', 'lisk'];

const adapters = {
  chain: chainAdapter,
  lisk: liskAdapter,
};

const resolveAdapter = (chain) => {
  const adapter = adapters[chain];
  if (!adapter) {
    throw new Error(`Unsupported chain: ${chain}`);
  }
  return adapter;
};

// Infer chain from address shape so users never have to declare which chain
// they mean. chain public keys are 56-char AddressCodec starting with 'G'; Lisk
// (EVM) addresses are '0x' followed by 40 hex characters.
const detectChainFromAddress = (address) => {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (chainAdapter.validateAddress(trimmed.toUpperCase())) return 'chain';
  if (liskAdapter.validateAddress(trimmed)) return 'lisk';
  return null;
};

module.exports = {
  SUPPORTED_CHAINS,
  resolveAdapter,
  detectChainFromAddress,
};
