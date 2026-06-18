const { createWalletForUser, getWalletByPhoneNumber, getWalletByUserId, markWalletFunded } = require('../services/wallet.service');
const { getBalance, fundAccount, isValidPublicKey } = require('../services/stellar.service');
const { executeSend } = require('../services/transaction.service');
const { isValidPhoneNumber, isValidAmount } = require('../utils/validators');
const User = require('../models/User');
const { sendSuccess, sendError } = require('../utils/response');

const createWallet = async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;
    if (!isValidPhoneNumber(phoneNumber)) return sendError(res, 'A valid phone number is required');

    let user = await User.findOne({ phoneNumber });
    if (!user) {
      user = await User.create({ phoneNumber });
    }

    try {
      const wallet = await createWalletForUser(user._id);

      // Attempt to fund testnet, then persist the funded flag so this matches
      // the WhatsApp flow (which marks the wallet funded on success). Without
      // this, REST-created wallets stayed funded:false despite being funded.
      await fundAccount(wallet.publicKey);
      await markWalletFunded(wallet._id);

      return sendSuccess(res, {
        publicKey: wallet.publicKey,
        network: wallet.network
      }, 'Wallet created and funded successfully', 201);
    } catch (err) {
      if (err.message === 'User already has a wallet') {
        const existingWallet = await getWalletByUserId(user._id);
        return sendSuccess(res, {
          publicKey: existingWallet.publicKey,
          network: existingWallet.network
        }, 'Wallet already exists');
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
};

const checkBalance = async (req, res, next) => {
  try {
    const { phone } = req.params;
    if (!isValidPhoneNumber(phone)) return sendError(res, 'A valid phone number is required');

    const wallet = await getWalletByPhoneNumber(phone);
    if (!wallet) return sendError(res, 'Wallet not found for this phone number', 404);

    const balance = await getBalance(wallet.publicKey);
    return sendSuccess(res, { balance, publicKey: wallet.publicKey }, 'Balance fetched successfully');
  } catch (error) {
    next(error);
  }
};

const sendFunds = async (req, res, next) => {
  try {
    const { phoneNumber, amount, destination } = req.body;

    if (!isValidPhoneNumber(phoneNumber) || !isValidAmount(amount) || !destination) {
      return sendError(res, 'A valid phone number, amount, and destination are required');
    }
    if (!isValidPublicKey(destination)) {
      return sendError(res, 'Destination must be a valid Stellar public key');
    }

    const user = await User.findOne({ phoneNumber });
    if (!user) return sendError(res, 'User not found', 404);

    const wallet = await getWalletByUserId(user._id);
    if (!wallet) return sendError(res, 'Wallet not found', 404);

    const result = await executeSend({ user, wallet, destination, amount, asset: 'XLM' });
    if (!result.ok) {
      return sendError(res, result.error.message || 'Transaction failed');
    }

    return sendSuccess(res, {
      txHash: result.txHash,
      explorerUrl: result.explorerUrl
    }, 'Transaction successful');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWallet,
  checkBalance,
  sendFunds
};
