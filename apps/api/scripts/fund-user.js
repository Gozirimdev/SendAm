#!/usr/bin/env node
/**
 * Funds a SendAm user's wallet directly from your own wallet — gas and USDC —
 * without any backend configuration.
 *
 *   export FUNDER_PRIVATE_KEY=0x...        # your MetaMask key, never in a file
 *   npm run fund:user -- +2348012345678                      # dry run
 *   npm run fund:user -- +2348012345678 --confirm            # gas + 10 USDC
 *   npm run fund:user -- 0xUserWallet --usdc 20 --confirm
 *   npm run fund:user -- +2348012345678 --gas-only --confirm
 *
 * Why this exists: the in-chat "fund me" faucet needs a treasury address set as
 * an env var on the API, which is no use if you don't control the deployment.
 * This does the same job from your machine — look the user up by phone number,
 * send them gas on Lisk, and bridge them USDC — and needs no deploy, no
 * SERVICE_SECRET, and no central gas payer. Users pay their own gas out of what
 * they're given here.
 *
 * Two chains are involved because Circle's faucet cannot mint on Lisk:
 *   gas  — sent directly on Lisk Sepolia
 *   USDC — bridged from Ethereum Sepolia (see bridge-usdc-to-lisk.js)
 * Your one key controls the same address on both.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const prisma = require('../src/common/prisma');
const config = require('../src/config/env');
const { phoneCandidates, looksLikePhone } = require('../src/utils/phone');
const { withRetry } = require('./lib/retry');

const L1_ADAPTER = '0x8454EAd8e8B6D63951033F38D61A5F0AC6f40279';
const L1_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const L2_ADAPTER = '0x45c01066E6b913D2EF4ad48E3629E66Ae41904b1';
const SEPOLIA_CHAIN_ID = 11155111n;
const BRIDGE_MIN_GAS = 300000;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const ADAPTER_ABI = [
  'function USDC() view returns (address)',
  'function LINKED_ADAPTER() view returns (address)',
  'function sendMessage(address,uint256,uint32)',
];

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

// Flags that consume the next argument. Needed to tell a positional recipient
// from a flag's value: a phone number given without a '+' is all digits, and so
// is `--usdc 20`'s value. Skipping value-taking flags explicitly is the only
// way to distinguish them.
const VALUE_FLAGS = new Set(['--usdc', '--gas']);
const positional = () => {
  for (let i = 0; i < argv.length; i += 1) {
    if (VALUE_FLAGS.has(argv[i])) {
      i += 1; // skip this flag's value
      continue;
    }
    if (argv[i].startsWith('--')) continue;
    return argv[i];
  }
  return undefined;
};
const target = positional();

(async () => {
  const key = process.env.FUNDER_PRIVATE_KEY || process.env.SEPOLIA_PRIVATE_KEY;
  if (!key) {
    console.error('Set FUNDER_PRIVATE_KEY first (export it — do not pass it as an argument).');
    process.exit(1);
  }
  if (!target) {
    console.error('Usage: npm run fund:user -- <phone|address> [--usdc 10] [--gas 0.0002] [--gas-only] [--confirm]');
    process.exit(1);
  }

  // 1. Resolve the recipient. Only reads the address, so this needs no
  //    SERVICE_SECRET — the user's own key stays sealed in the database.
  let recipient = target;
  if (!ethers.isAddress(target)) {
    if (!looksLikePhone(target)) throw new Error(`"${target}" is not a phone number or an address.`);
    const user = await prisma.user.findFirst({
      where: { phoneNumber: { in: phoneCandidates(target) } },
      include: { wallet: true },
    });
    if (!user) throw new Error(`No SendAm user found for ${target}. They need to message the bot first.`);
    recipient = user.wallet?.address;
    if (!recipient) throw new Error(`${target} is registered but has no wallet yet — they need to finish setup.`);
    console.log(`${target} -> ${recipient}\n`);
  }
  recipient = ethers.getAddress(recipient);

  const gasAmount = flag('gas') || config.lisk.gasTopUpTo;
  const usdcAmount = has('gas-only') ? null : flag('usdc') || '10';
  const doGas = !has('usdc-only');

  // 2. Gas, on Lisk Sepolia.
  const liskProvider = new ethers.JsonRpcProvider(config.lisk.rpcUrl, undefined, {
    staticNetwork: ethers.Network.from(4202),
  });
  const liskSigner = new ethers.Wallet(key, liskProvider);
  const funder = await liskSigner.getAddress();

  const [funderLisk, recipientLisk] = await withRetry(
    () => Promise.all([liskProvider.getBalance(funder), liskProvider.getBalance(recipient)]),
    { label: 'reading Lisk balances' }
  );

  console.log(`funding from    : ${funder}`);
  console.log(`recipient       : ${recipient}`);
  console.log(`  their gas     : ${ethers.formatEther(recipientLisk)} ETH on Lisk`);
  console.log(`  your gas      : ${ethers.formatEther(funderLisk)} ETH on Lisk`);
  if (doGas) console.log(`  will send     : ${gasAmount} ETH`);
  if (usdcAmount) console.log(`  will bridge   : ${usdcAmount} USDC -> USDC.e`);
  console.log('');

  if (doGas && funderLisk < ethers.parseEther(String(gasAmount))) {
    throw new Error(
      `You only hold ${ethers.formatEther(funderLisk)} ETH on Lisk Sepolia, need ${gasAmount}. ` +
        'Claim some at https://console.optimism.io/faucet (choose Lisk Sepolia).'
    );
  }

  if (!has('confirm')) {
    console.log('Dry run — nothing sent. Re-run with --confirm to execute.');
    process.exit(0);
  }

  if (doGas) {
    console.log('sending gas on Lisk...');
    const tx = await liskSigner.sendTransaction({ to: recipient, value: ethers.parseEther(String(gasAmount)) });
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();
    console.log('  done');
  }

  // 3. USDC, bridged from Ethereum Sepolia.
  if (usdcAmount) {
    const sepoliaRpc = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
    const sepolia = new ethers.JsonRpcProvider(sepoliaRpc, undefined, {
      staticNetwork: ethers.Network.from(Number(SEPOLIA_CHAIN_ID)),
    });
    const net = await sepolia.getNetwork();
    if (net.chainId !== SEPOLIA_CHAIN_ID) {
      throw new Error(`SEPOLIA_RPC_URL points at chain ${net.chainId}, expected Ethereum Sepolia.`);
    }

    const sepoliaSigner = new ethers.Wallet(key, sepolia);
    const adapter = new ethers.Contract(L1_ADAPTER, ADAPTER_ABI, sepoliaSigner);

    // Same check as bridge-usdc-to-lisk.js: confirm this really is the adapter
    // wired to this USDC and to Lisk, before approving anything.
    const [wiredUsdc, wiredLinked] = await withRetry(
      () => Promise.all([adapter.USDC(), adapter.LINKED_ADAPTER()]),
      { label: 'verifying the bridge adapter' }
    );
    if (ethers.getAddress(wiredUsdc) !== ethers.getAddress(L1_USDC)) {
      throw new Error(`Adapter's USDC() is ${wiredUsdc}, expected ${L1_USDC}. Refusing to continue.`);
    }
    if (ethers.getAddress(wiredLinked) !== ethers.getAddress(L2_ADAPTER)) {
      throw new Error(`Adapter's LINKED_ADAPTER() is ${wiredLinked}, expected ${L2_ADAPTER}. Refusing to continue.`);
    }

    const usdc = new ethers.Contract(L1_USDC, ERC20_ABI, sepoliaSigner);
    const [decimals, balance, allowance] = await withRetry(
      () => Promise.all([usdc.decimals(), usdc.balanceOf(funder), usdc.allowance(funder, L1_ADAPTER)]),
      { label: 'reading Sepolia balances' }
    );
    const amount = ethers.parseUnits(String(usdcAmount), decimals);

    if (balance < amount) {
      throw new Error(
        `You hold ${ethers.formatUnits(balance, decimals)} USDC on Sepolia, need ${usdcAmount}. ` +
          'Claim 20 every 2h at https://faucet.circle.com/ (choose Ethereum Sepolia).'
      );
    }

    if (allowance < amount) {
      console.log('approving the bridge...');
      await (await usdc.approve(L1_ADAPTER, amount)).wait();
    }

    console.log('bridging USDC...');
    const tx = await adapter.sendMessage(recipient, amount, BRIDGE_MIN_GAS);
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();
    console.log('  done — the Lisk side mints in a few minutes');
  }

  console.log('');
  console.log('Check it landed:');
  console.log(`  npm run wallet:check -- ${recipient}`);
  process.exit(0);
})().catch((error) => {
  console.error('FAILED:', error.shortMessage || error.message);
  process.exit(1);
});
