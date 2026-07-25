#!/usr/bin/env node
/**
 * Reports whether a wallet can actually send: its USDC balance, its native
 * balance for gas, and the real cost of one transfer at current network prices.
 *
 *   node scripts/check-wallet-funding.js 0xYourWalletAddress
 *   node scripts/check-wallet-funding.js +2348012345678     # by phone number
 *
 * Answers the question "not enough money — which money?", which the on-chain
 * revert string alone does not distinguish.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const config = require('../src/config/env');
const { withRetry } = require('./lib/retry');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/check-wallet-funding.js <address|phoneNumber>');
  process.exit(1);
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

(async () => {
  if (!config.lisk.rpcUrl) throw new Error('LISK_RPC_URL is not set.');
  if (!config.lisk.usdcContractAddress) throw new Error('LISK_USDC_CONTRACT_ADDRESS is not set.');

  let address = target;
  if (!ethers.isAddress(target)) {
    const prisma = require('../src/common/prisma');
    const { phoneCandidates } = require('../src/utils/phone');
    const user = await prisma.user.findFirst({
      where: { phoneNumber: { in: phoneCandidates(target) } },
      include: { wallet: true },
    });
    if (!user) throw new Error(`No user found for ${target}`);
    address = user.wallet?.address;
    if (!address) throw new Error(`${target} is registered but has no wallet yet.`);
    console.log(`resolved ${target} -> ${address}\n`);
  }

  const provider = new ethers.JsonRpcProvider(config.lisk.rpcUrl, undefined, {
    staticNetwork: ethers.Network.from(Number(config.lisk.chainId) || 4202),
  });
  const token = new ethers.Contract(config.lisk.usdcContractAddress, ERC20_ABI, provider);

  const [decimals, symbol, tokenRaw, nativeRaw, feeData] = await withRetry(
    () =>
      Promise.all([
        token.decimals(),
        token.symbol(),
        token.balanceOf(address),
        provider.getBalance(address),
        provider.getFeeData(),
      ]),
    { label: 'reading balances' }
  );

  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  // 65k is a typical ERC-20 transfer; the L1 data fee on this OP Stack chain
  // adds roughly another third on top, so treat 100k as the practical ceiling.
  const oneTransfer = 100_000n * gasPrice;

  const native = config.lisk.nativeSymbol;
  console.log(`address        : ${address}`);
  console.log(`${symbol.padEnd(15)}: ${ethers.formatUnits(tokenRaw, decimals)}`);
  console.log(`${native.padEnd(15)}: ${ethers.formatEther(nativeRaw)}   (pays gas)`);
  console.log(`gas price      : ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  console.log(`cost / transfer: ~${ethers.formatEther(oneTransfer)} ${native}`);
  console.log('');

  const problems = [];
  if (tokenRaw === 0n) problems.push(`no ${symbol} to send — fund the wallet with ${symbol}`);
  if (nativeRaw < oneTransfer) {
    problems.push(
      `not enough ${native} for gas — send it about 0.0001 ${native} ` +
        `(covers ~${(0.0001 / Number(ethers.formatEther(oneTransfer))).toFixed(0)} transfers)`
    );
  }

  if (problems.length === 0) {
    const affordable = Number(ethers.formatEther(nativeRaw)) / Number(ethers.formatEther(oneTransfer));
    console.log(`READY — can send, and holds gas for ~${affordable.toFixed(0)} more transfers.`);
  } else {
    console.log('CANNOT SEND:');
    for (const p of problems) console.log(`  - ${p}`);
  }
  process.exit(0);
})().catch((error) => {
  console.error('FAILED:', error.shortMessage || error.message);
  process.exit(1);
});
