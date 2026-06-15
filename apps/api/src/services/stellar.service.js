const { server, StellarSdk } = require('../config/stellar');
const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/env');

const createKeypair = () => {
  const keypair = StellarSdk.Keypair.random();
  return {
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
  };
};

const isValidPublicKey = (publicKey) => {
  return StellarSdk.StrKey.isValidEd25519PublicKey(publicKey);
};

const getTransactionUrl = (txHash) => {
  const network = config.stellar.network === 'testnet' ? 'testnet' : 'public';
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
};

const fundAccount = async (publicKey) => {
  try {
    const response = await axios.get(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
    return response.data;
  } catch (error) {
    logger.error('Error funding account with Friendbot', error.message);
    throw new Error('Failed to fund account on Testnet');
  }
};

const getBalance = async (publicKey) => {
  try {
    const account = await server.loadAccount(publicKey);
    const xlmBalance = account.balances.find((b) => b.asset_type === 'native');
    return xlmBalance ? xlmBalance.balance : '0';
  } catch (error) {
    logger.error('Error getting balance', error.message);
    throw new Error('Could not fetch balance. Check if account is funded.');
  }
};

// Resolve an asset code to a Stellar SDK Asset. Native XLM is the only
// asset wired today; this is the seam where future assets (e.g. USDC and
// other anchor-issued assets used by on/off-ramps and swaps) get added by
// mapping a code+issuer instead of throwing.
const resolveAsset = (asset) => {
  if (!asset || asset === 'XLM' || asset === 'native') {
    return StellarSdk.Asset.native();
  }
  throw new Error(`Unsupported asset: ${asset}`);
};

const sendPayment = async ({ secretKey, destination, amount, asset = 'XLM' }) => {
  try {
    if (!isValidPublicKey(destination)) {
      throw new Error('Destination must be a valid Stellar public key.');
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new Error('Amount must be greater than zero.');
    }

    const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
    const sourcePublicKey = sourceKeypair.publicKey();

    // Load source account to get current sequence number
    const sourceAccount = await server.loadAccount(sourcePublicKey);

    // Check if destination exists
    try {
      await server.loadAccount(destination);
    } catch (e) {
      throw new Error('Destination account does not exist or is not funded.');
    }

    // Build the transaction
    const fee = await server.fetchBaseFee();

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: config.stellar.network === 'testnet' ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC,
    })
      .addOperation(StellarSdk.Operation.payment({
        destination,
        asset: resolveAsset(asset),
        amount: amount.toString(),
      }))
      .setTimeout(30)
      .build();

    // Sign transaction
    transaction.sign(sourceKeypair);

    // Submit transaction
    const response = await server.submitTransaction(transaction);
    return response;
  } catch (error) {
    logger.error('Error sending payment', error.message);
    throw new Error(error.message || 'Failed to send payment');
  }
};

module.exports = {
  createKeypair,
  fundAccount,
  getTransactionUrl,
  getBalance,
  isValidPublicKey,
  resolveAsset,
  sendPayment,
};
