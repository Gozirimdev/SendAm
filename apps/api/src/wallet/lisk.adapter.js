const { ethers } = require('ethers');
const config = require('../config/env');
const cryptoService = require('../services/crypto.service');
const prisma = require('../common/prisma');

// Minimal ERC-20 surface: this is all we call against the USDC contract on Lisk.
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

let cachedProvider;
const provider = () => {
  if (!config.lisk.rpcUrl) {
    throw new Error('Lisk RPC is not configured. Set LISK_RPC_URL.');
  }
  if (!cachedProvider) cachedProvider = new ethers.JsonRpcProvider(config.lisk.rpcUrl);
  return cachedProvider;
};

// Self-custody: the wallet's private key never leaves this process. It's
// generated here, encrypted at rest via crypto.service (AES-256-GCM), and
// only decrypted in-memory for the lifetime of a single signing call.
const createManagedWallet = async () => {
  const wallet = ethers.Wallet.createRandom();
  return {
    providerWalletId: wallet.address,
    address: wallet.address,
    encryptedSecretKey: cryptoService.encrypt(wallet.privateKey),
  };
};

// `chain` is accepted for interface parity with the other adapters but
// unused: this adapter only ever talks to Lisk.
const getBalance = async ({ address, tokenAddress = config.lisk.usdcContractAddress }) => {
  if (!tokenAddress) {
    throw new Error('Token contract address is required to read a balance.');
  }
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider());
  const [raw, decimals] = await Promise.all([token.balanceOf(address), token.decimals()]);
  return { value: ethers.formatUnits(raw, decimals), raw: raw.toString(), decimals };
};

// Native LSK balance, in wei — used by the payment orchestrator to decide
// whether the sending wallet needs a gas top-up before a token transfer.
const getNativeBalance = async ({ address }) => {
  const raw = await provider().getBalance(address);
  return { value: ethers.formatEther(raw), raw: raw.toString() };
};

const signerFor = async (fromAddress) => {
  const wallet = await prisma.wallet.findFirst({ where: { address: fromAddress } });
  if (!wallet || !wallet.encryptedSecretKey) {
    throw new Error(`No self-custodied key found for address ${fromAddress}.`);
  }
  const privateKey = cryptoService.decrypt(wallet.encryptedSecretKey);
  return new ethers.Wallet(privateKey, provider());
};

const sendToken = async ({ fromAddress, destination, amount, tokenAddress = config.lisk.usdcContractAddress }) => {
  if (!tokenAddress) {
    throw new Error('Token contract address is required for a Lisk token transfer.');
  }
  const signer = await signerFor(fromAddress);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const decimals = await token.decimals();
  const tx = await token.transfer(destination, ethers.parseUnits(String(amount), decimals));
  const receipt = await tx.wait();
  return {
    transactionHash: receipt.hash,
    explorerUrl: config.lisk.explorerBaseUrl ? `${config.lisk.explorerBaseUrl}/tx/${receipt.hash}` : undefined,
  };
};

// Moves native LSK from the platform gas wallet to a user wallet that's
// below its gas threshold. `amountWei` comes from a paymaster top-up plan
// (see paymaster.client.js) — paymaster only plans, this executes it.
const sendNative = async ({ fromAddress, destination, amountWei }) => {
  const signer = await signerFor(fromAddress);
  const tx = await signer.sendTransaction({ to: destination, value: BigInt(amountWei) });
  const receipt = await tx.wait();
  return { transactionHash: receipt.hash };
};

module.exports = {
  createManagedWallet,
  getBalance,
  getNativeBalance,
  sendToken,
  sendNative,
};
