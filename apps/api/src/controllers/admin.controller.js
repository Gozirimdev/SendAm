const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const { sendSuccess, sendError } = require('../utils/response');
const { verifyPassword, createToken } = require('../services/adminAuth.service');

const login = async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!verifyPassword(password)) {
      return sendError(res, 'Invalid credentials', 401);
    }
    const token = createToken();
    return sendSuccess(res, { token }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

const getStats = async (req, res, next) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalWallets = await Wallet.countDocuments();
    const totalTransactions = await Transaction.countDocuments();
    const successfulTransactions = await Transaction.countDocuments({ status: 'success' });
    const failedTransactions = await Transaction.countDocuments({ status: 'failed' });

    sendSuccess(res, {
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions
    });
  } catch (error) {
    next(error);
  }
};

const getUsers = async (req, res, next) => {
  try {
    const users = await User.find().populate('walletId', 'publicKey network createdAt').sort({ createdAt: -1 });
    sendSuccess(res, users);
  } catch (error) {
    next(error);
  }
};

const getWallets = async (req, res, next) => {
  try {
    // Exclude walletReference from output
    const wallets = await Wallet.find().select('-walletReference').populate('userId', 'phoneNumber whatsappName').sort({ createdAt: -1 });
    sendSuccess(res, wallets);
  } catch (error) {
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const transactions = await Transaction.find().populate('userId', 'phoneNumber').sort({ createdAt: -1 });
    sendSuccess(res, transactions);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  getStats,
  getUsers,
  getWallets,
  getTransactions
};
