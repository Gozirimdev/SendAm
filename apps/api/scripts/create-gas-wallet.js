#!/usr/bin/env node
/**
 * Creates (or imports) the platform gas wallet that funds user wallets with
 * the native ETH they need to pay for transfers.
 *
 *   node scripts/create-gas-wallet.js                    # generate a new key
 *   node scripts/create-gas-wallet.js --key 0xabc123...   # import an existing one
 *
 * Prints the address to set as LISK_GAS_WALLET_ADDRESS and to fund.
 *
 * Why a Wallet row: lisk.adapter#signerFor looks a signer up by address in the
 * Wallet table and decrypts its stored key, so the gas wallet has to live there
 * like any other. Wallet.userId is required and unique, so this also creates a
 * reserved system User to own it — it is not a real person and never receives
 * WhatsApp messages.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const prisma = require('../src/common/prisma');
const cryptoService = require('../src/services/crypto.service');
const config = require('../src/config/env');

const SYSTEM_PHONE = 'system:lisk-gas-wallet';

const args = process.argv.slice(2);
const keyIndex = args.indexOf('--key');
const importedKey = keyIndex !== -1 ? args[keyIndex + 1] : undefined;

if (keyIndex !== -1 && !importedKey) {
  console.error('--key needs a private key value.');
  process.exit(1);
}

(async () => {
  let wallet;
  try {
    wallet = importedKey ? new ethers.Wallet(importedKey) : ethers.Wallet.createRandom();
  } catch (error) {
    throw new Error(`Could not read the supplied private key: ${error.message}`);
  }

  const existing = await prisma.user.findUnique({
    where: { phoneNumber: SYSTEM_PHONE },
    include: { wallet: true },
  });

  if (existing?.wallet?.address) {
    console.log('A gas wallet already exists for this database:\n');
    console.log(`  address: ${existing.wallet.address}\n`);
    console.log('Refusing to replace it — a second one would strand whatever is funding the first.');
    console.log('To rotate deliberately, delete that Wallet row first, then re-run.');
    process.exit(1);
  }

  const owner =
    existing ||
    (await prisma.user.create({
      data: { phoneNumber: SYSTEM_PHONE, preferredName: 'SendAm gas wallet' },
    }));

  const created = await prisma.wallet.create({
    data: {
      userId: owner.id,
      phoneNumber: SYSTEM_PHONE,
      provider: 'lisk',
      providerWalletId: wallet.address,
      address: wallet.address,
      publicKey: wallet.address,
      encryptedSecretKey: cryptoService.encrypt(wallet.privateKey),
      primaryChain: 'lisk',
      supportedChains: ['lisk'],
      network: 'self-custody',
    },
  });
  await prisma.user.update({ where: { id: owner.id }, data: { walletId: created.id } });

  const native = config.lisk.nativeSymbol;
  console.log('Gas wallet created. Its private key is encrypted at rest with ENCRYPTION_KEY.\n');
  console.log(`  LISK_GAS_WALLET_ADDRESS=${wallet.address}\n`);
  console.log('Next:');
  console.log(`  1. Set that env var on the API.`);
  console.log(`  2. Fund the address with ${native} on Lisk Sepolia:`);
  console.log('       https://console.optimism.io/faucet   (Superchain faucet, supports Lisk Sepolia)');
  console.log(`     0.01 ${native} is already ~100,000 transfers.`);
  console.log(`  3. Check it: node scripts/check-wallet-funding.js ${wallet.address}`);
  console.log('');
  console.log(`Top-ups then happen automatically: any user wallet below ${config.lisk.gasMinBalance} ${native}`);
  console.log(`is refilled to ${config.lisk.gasTopUpTo} ${native} before its transfer is submitted.`);

  if (!importedKey) {
    console.log('\nBack up this private key somewhere safe — it is the only copy outside the database:');
    console.log(`  ${wallet.privateKey}`);
  }
  process.exit(0);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
