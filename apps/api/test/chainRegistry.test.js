const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

// secretStore (pulled in transitively) validates the encryption key at
// require-time, so set it before importing.
process.env.SERVICE_SECRET = 'a'.repeat(64);

const { resolveAdapter, detectChainFromAddress, SUPPORTED_CHAINS } = require('../src/wallet/chainIndex');

const VALID_CHAIN_KEY = 'GA6UY5O4LMTQLBFXIQXOGM5JK4GNAVXHKYYXKSCIXVHCJ7ETQW55EAAZ';
const VALID_LISK_ADDRESS = ethers.Wallet.createRandom().address;

test('SUPPORTED_CHAINS lists exactly chain and lisk', () => {
  assert.deepEqual([...SUPPORTED_CHAINS].sort(), ['lisk', 'chain']);
});

test('resolveAdapter returns the matching adapter', () => {
  assert.equal(resolveAdapter('chain').chain, 'chain');
  assert.equal(resolveAdapter('lisk').chain, 'lisk');
});

test('resolveAdapter throws for an unsupported chain', () => {
  assert.throws(() => resolveAdapter('solana'), /Unsupported chain/);
});

test('detectChainFromAddress recognizes a chain key regardless of case', () => {
  assert.equal(detectChainFromAddress(VALID_CHAIN_KEY), 'chain');
  assert.equal(detectChainFromAddress(VALID_CHAIN_KEY.toLowerCase()), 'chain');
});

test('detectChainFromAddress recognizes a Lisk (EVM) address', () => {
  assert.equal(detectChainFromAddress(VALID_LISK_ADDRESS), 'lisk');
  assert.equal(detectChainFromAddress(VALID_LISK_ADDRESS.toLowerCase()), 'lisk');
});

test('detectChainFromAddress returns null for garbage input', () => {
  assert.equal(detectChainFromAddress('not-an-address'), null);
  assert.equal(detectChainFromAddress(''), null);
  assert.equal(detectChainFromAddress(undefined), null);
});

test('chain.reader validateAddress accepts only valid chain keys', () => {
  const chainAdapter = resolveAdapter('chain');
  assert.equal(chainAdapter.validateAddress(VALID_CHAIN_KEY), true);
  assert.equal(chainAdapter.validateAddress(VALID_LISK_ADDRESS), false);
  assert.equal(chainAdapter.validateAddress('garbage'), false);
});

test('lisk.reader validateAddress accepts only valid EVM addresses', () => {
  const liskAdapter = resolveAdapter('lisk');
  assert.equal(liskAdapter.validateAddress(VALID_LISK_ADDRESS), true);
  assert.equal(liskAdapter.validateAddress(VALID_CHAIN_KEY), false);
  assert.equal(liskAdapter.validateAddress('garbage'), false);
});

test('lisk.reader createWallet produces a valid, unique address each time', () => {
  const liskAdapter = resolveAdapter('lisk');
  const a = liskAdapter.createWallet();
  const b = liskAdapter.createWallet();
  assert.equal(liskAdapter.validateAddress(a.publicKey), true);
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(a.secretKey, b.secretKey);
});

test('lisk.reader resolveAsset accepts native/ETH and rejects anything else', () => {
  const liskAdapter = resolveAdapter('lisk');
  assert.doesNotThrow(() => liskAdapter.resolveAsset('ETH'));
  assert.doesNotThrow(() => liskAdapter.resolveAsset('native'));
  assert.doesNotThrow(() => liskAdapter.resolveAsset());
  assert.throws(() => liskAdapter.resolveAsset('TOKEN'), /Unsupported asset/);
});

test('lisk.reader fundTestnetAccount reports itself as manual, not automated', async () => {
  const liskAdapter = resolveAdapter('lisk');
  const result = await liskAdapter.fundTestnetAccount(VALID_LISK_ADDRESS);
  assert.equal(result.funded, false);
  assert.equal(result.manual, true);
  assert.match(result.instructions, /faucet/i);
});
