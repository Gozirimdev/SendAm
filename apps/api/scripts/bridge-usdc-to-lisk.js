#!/usr/bin/env node
/**
 * Bridges testnet USDC from Ethereum Sepolia to USDC.e on Lisk Sepolia.
 *
 *   export SEPOLIA_PRIVATE_KEY=0x...        # never pass this as an argument
 *   node scripts/bridge-usdc-to-lisk.js --amount 20            # dry run
 *   node scripts/bridge-usdc-to-lisk.js --amount 20 --confirm  # actually send
 *
 * Optionally --to 0xRecipient to deliver straight into a SendAm user wallet
 * instead of the same address on L2.
 *
 * The key is read from the environment, never from argv: process arguments are
 * visible to every other process via `ps` and land in shell history. It is used
 * to sign locally and is never transmitted anywhere except as a signed
 * transaction.
 *
 * Why not the standard OP bridge: USDC.e on Lisk is Circle's Bridged USDC
 * Standard, so it does NOT implement OptimismMintableERC20 (l1Token() and
 * remoteToken() both revert) and the L2StandardBridge cannot mint it. Deposits
 * go through a dedicated pair of adapters, verified on-chain below.
 */
const { ethers } = require('ethers');

// Ethereum Sepolia. USDC() and LINKED_ADAPTER() on this contract are checked
// against the constants below at runtime, so a wrong address here fails loudly
// rather than sending funds somewhere unrecoverable.
const L1_ADAPTER = '0x8454EAd8e8B6D63951033F38D61A5F0AC6f40279';
const L1_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const L2_ADAPTER = '0x45c01066E6b913D2EF4ad48E3629E66Ae41904b1';
const SEPOLIA_CHAIN_ID = 11155111n;

// Gas the L2 side gets to run the mint. The deposit is paid for on L1; too low
// and the message arrives but cannot execute.
const MIN_GAS_LIMIT = 300000;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const ADAPTER_ABI = [
  'function USDC() view returns (address)',
  'function LINKED_ADAPTER() view returns (address)',
  'function sendMessage(address _to, uint256 _amount, uint32 _minGasLimit)',
];

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const has = (name) => process.argv.includes(`--${name}`);

(async () => {
  const key = process.env.SEPOLIA_PRIVATE_KEY;
  if (!key) {
    console.error('Set SEPOLIA_PRIVATE_KEY first (export it — do not pass it as an argument).');
    process.exit(1);
  }
  const amountArg = arg('amount');
  if (!amountArg) {
    console.error('Usage: node scripts/bridge-usdc-to-lisk.js --amount 20 [--to 0x...] [--confirm]');
    process.exit(1);
  }

  const rpc = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
  const provider = new ethers.JsonRpcProvider(rpc, undefined, {
    staticNetwork: ethers.Network.from(Number(SEPOLIA_CHAIN_ID)),
  });

  const net = await provider.getNetwork();
  if (net.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`SEPOLIA_RPC_URL points at chain ${net.chainId}, expected ${SEPOLIA_CHAIN_ID} (Ethereum Sepolia).`);
  }

  const signer = new ethers.Wallet(key, provider);
  const from = await signer.getAddress();
  const to = arg('to') ? ethers.getAddress(arg('to')) : from;

  const adapter = new ethers.Contract(L1_ADAPTER, ADAPTER_ABI, signer);

  // Confirm the adapter really is the one wired to this USDC and to the Lisk
  // L2 adapter, before any approval is granted.
  const [wiredUsdc, wiredLinked] = await Promise.all([adapter.USDC(), adapter.LINKED_ADAPTER()]);
  if (ethers.getAddress(wiredUsdc) !== ethers.getAddress(L1_USDC)) {
    throw new Error(`Adapter's USDC() is ${wiredUsdc}, expected ${L1_USDC}. Refusing to continue.`);
  }
  if (ethers.getAddress(wiredLinked) !== ethers.getAddress(L2_ADAPTER)) {
    throw new Error(`Adapter's LINKED_ADAPTER() is ${wiredLinked}, expected ${L2_ADAPTER}. Refusing to continue.`);
  }

  const usdc = new ethers.Contract(L1_USDC, ERC20_ABI, signer);
  const [decimals, balance, allowance, ethBalance] = await Promise.all([
    usdc.decimals(),
    usdc.balanceOf(from),
    usdc.allowance(from, L1_ADAPTER),
    provider.getBalance(from),
  ]);

  const amount = ethers.parseUnits(String(amountArg), decimals);

  console.log(`from            : ${from}`);
  console.log(`to (on Lisk)    : ${to}`);
  console.log(`USDC on Sepolia : ${ethers.formatUnits(balance, decimals)}`);
  console.log(`ETH on Sepolia  : ${ethers.formatEther(ethBalance)}   (pays for the deposit tx)`);
  console.log(`bridging        : ${ethers.formatUnits(amount, decimals)} USDC -> USDC.e on Lisk Sepolia`);
  console.log('');

  if (balance < amount) {
    throw new Error(
      `Not enough USDC on Sepolia: have ${ethers.formatUnits(balance, decimals)}, need ${amountArg}. ` +
        'Claim 20 every 2h at https://faucet.circle.com/'
    );
  }
  if (ethBalance === 0n) {
    throw new Error('No Sepolia ETH to pay for the deposit transaction. Get some at https://faucets.chain.link/sepolia');
  }

  if (!has('confirm')) {
    console.log('Dry run — nothing sent. Re-run with --confirm to execute.');
    process.exit(0);
  }

  if (allowance < amount) {
    console.log('approving the bridge adapter...');
    const approveTx = await usdc.approve(L1_ADAPTER, amount);
    console.log(`  approve tx: ${approveTx.hash}`);
    await approveTx.wait();
  }

  console.log('submitting the deposit...');
  const tx = await adapter.sendMessage(to, amount, MIN_GAS_LIMIT);
  console.log(`  deposit tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt.blockNumber}`);
  console.log('');
  console.log('The L2 mint is relayed automatically, usually within a few minutes. Check with:');
  console.log(`  node scripts/check-wallet-funding.js ${to}`);
  process.exit(0);
})().catch((error) => {
  console.error('FAILED:', error.shortMessage || error.message);
  process.exit(1);
});
