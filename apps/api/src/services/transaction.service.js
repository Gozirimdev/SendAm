const { decrypt } = require('./crypto.service');
const { sendPayment, getTransactionUrl } = require('./stellar.service');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

/**
 * The single money-movement pipeline shared by every surface (REST API and
 * the WhatsApp bot). It owns the side effects of a transfer: decrypt the
 * sender's key, submit on-ledger, and record the outcome as a Transaction.
 *
 * Both success and failure are persisted so the admin ledger stays complete.
 * The result is returned (never thrown) so callers can shape their own reply
 * without duplicating this logic — this is the seam future flows (offramp,
 * onramp, swap) extend rather than copy.
 */
const executeSend = async ({ user, wallet, destination, amount, asset = 'XLM' }) => {
  try {
    const secretKey = decrypt(wallet.encryptedSecretKey);
    const txResponse = await sendPayment({ secretKey, destination, amount, asset });
    const explorerUrl = getTransactionUrl(txResponse.hash);

    const transaction = await Transaction.create({
      userId: user._id,
      type: 'send',
      amount,
      asset,
      destination,
      txHash: txResponse.hash,
      explorerUrl,
      status: 'success',
    });

    return { ok: true, txHash: txResponse.hash, explorerUrl, transaction };
  } catch (error) {
    logger.error('Send failed', error.message);

    await Transaction.create({
      userId: user._id,
      type: 'send',
      amount: amount || '0',
      asset,
      destination: destination || 'unknown',
      status: 'failed',
    });

    return { ok: false, error };
  }
};

module.exports = {
  executeSend,
};
