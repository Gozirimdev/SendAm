#!/usr/bin/env node
// Diagnostic: verifies the exact call path lisk.adapter.js getBalance() uses,
// step by step, against the configured envs. Run it locally AND on the deploy
// host (Render shell / `railway run node scripts/check-lisk-rpc.js`) — if it
// passes locally but fails deployed, the deployment envs are the problem.
//
// Exit code 0 = full balance path works. Non-zero = the printed step failed.

require('dotenv').config();
const { ethers } = require('ethers');

const RPC_URL = process.env.LISK_RPC_URL;
const USDC = process.env.LISK_USDC_CONTRACT_ADDRESS;
// Any address works for balanceOf — this only proves the contract call path.
const PROBE_ADDRESS = '0x0000000000000000000000000000000000000001';
const STEP_TIMEOUT_MS = 15_000;

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

let failed = false;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail) => {
  failed = true;
  console.error(`  FAIL  ${label} — ${detail}`);
};

const withTimeout = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS)
    ),
  ]);

(async () => {
  console.log('Lisk RPC balance-path check\n');

  // Step 1: envs present — the deployed failure mode this script exists to catch.
  console.log('1. Environment variables');
  if (RPC_URL) ok('LISK_RPC_URL is set', RPC_URL);
  else fail('LISK_RPC_URL is set', 'missing — adapter throws "Lisk RPC is not configured. Set LISK_RPC_URL."');
  if (USDC) ok('LISK_USDC_CONTRACT_ADDRESS is set', USDC);
  else fail('LISK_USDC_CONTRACT_ADDRESS is set', 'missing — adapter throws "Token contract address is required to read a balance."');
  if (failed) process.exit(1);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Step 2: RPC reachable at all.
  console.log('\n2. RPC connectivity (eth_chainId)');
  try {
    const network = await withTimeout(provider.getNetwork());
    ok('RPC reachable', `chainId ${network.chainId} (Lisk Sepolia = 4202, Lisk mainnet = 1135)`);
  } catch (error) {
    fail('RPC reachable', error.shortMessage || error.message);
    process.exit(2);
  }

  // Step 3: USDC address actually holds a contract on this chain.
  console.log('\n3. Token contract exists (eth_getCode)');
  try {
    const code = await withTimeout(provider.getCode(USDC));
    if (code && code !== '0x') ok('Contract code found', `${code.length} bytes of code at ${USDC}`);
    else {
      fail('Contract code found', `no code at ${USDC} — wrong address for this chain?`);
      process.exit(3);
    }
  } catch (error) {
    fail('Contract code found', error.shortMessage || error.message);
    process.exit(3);
  }

  // Step 4: the two calls getBalance() actually makes, in the same shape.
  console.log('\n4. Balance read (balanceOf + decimals, mirrors lisk.adapter.js getBalance)');
  try {
    const token = new ethers.Contract(USDC, ERC20_ABI, provider);
    const [raw, decimals] = await withTimeout(
      Promise.all([token.balanceOf(PROBE_ADDRESS), token.decimals()])
    );
    ok('Balance read works', `decimals=${decimals}, probe balance=${ethers.formatUnits(raw, decimals)}`);
  } catch (error) {
    fail('Balance read works', error.shortMessage || error.message);
    process.exit(4);
  }

  console.log('\nAll steps passed — the balance path works with these envs.');
  process.exit(0);
})();
