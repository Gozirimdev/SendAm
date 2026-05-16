const { parseCommand } = require('../services/parser.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { createWalletForUser, getWalletByUserId } = require('../services/wallet.service');
const { getBalance, getTransactionUrl, isValidPublicKey, sendXlm, fundAccount } = require('../services/stellar.service');
const { decrypt } = require('../services/crypto.service');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;

const handleIncomingMessage = async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const contacts = value?.contacts;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const contact = contacts?.[0];
    const from = message.from;
    const whatsappName = contact?.profile?.name || '';

    if (message.type !== 'text') return;

    processCommand(from, whatsappName, message.text.body).catch((err) => {
      logger.error(`Error processing command for ${from}:`, err);
      sendTextMessage(from, `Sorry, an error occurred: ${err.message}`);
    });
  } catch (error) {
    logger.error('Webhook processing error:', error);
  }
};

const processCommand = async (phoneNumber, whatsappName, text) => {
  let user = await User.findOne({ phoneNumber });
  if (!user) {
    user = await User.create({ phoneNumber, whatsappName });
  } else if (whatsappName && user.whatsappName !== whatsappName) {
    user.whatsappName = whatsappName;
    await user.save();
  }

  const command = parseCommand(text);

  switch (command.type) {
    case 'GREETING':
      await sendTextMessage(phoneNumber, `Hello ${whatsappName || 'there'}! Welcome to SendAm. Reply with 'help' to see available commands.`);
      break;

    case 'HELP':
      await sendTextMessage(phoneNumber, getHelpMessage());
      break;

    case 'CREATE_WALLET':
      await handleCreateWallet(phoneNumber, user);
      break;

    case 'BALANCE':
      await handleBalance(phoneNumber, user);
      break;

    case 'SAVE_CONTACT':
      await handleSaveContact(phoneNumber, user, command.payload);
      break;

    case 'LIST_CONTACTS':
      await handleListContacts(phoneNumber, user);
      break;

    case 'SEND_XLM':
      await handlePrepareSend(phoneNumber, user, command.payload);
      break;

    case 'CONFIRM_SEND':
      await handleConfirmSend(phoneNumber, user);
      break;

    case 'CANCEL_SEND':
      await handleCancelSend(phoneNumber, user);
      break;

    case 'INVALID_SEND':
      await sendTextMessage(phoneNumber, `Invalid send format. Please use: send <amount> xlm <address-or-name>\nExample: send 5 xlm GABC...`);
      break;

    case 'INVALID_SAVE':
      await sendTextMessage(phoneNumber, `Invalid save format. Please use: save <name> <stellar-address>\nExample: save ada GABC...`);
      break;

    default:
      await sendTextMessage(phoneNumber, `Sorry, I didn't understand that. Reply with 'help' to see what I can do.`);
  }
};

const getHelpMessage = () => {
  return [
    'Available commands:',
    '- create wallet: Create a new Stellar wallet',
    '- balance: Check your XLM balance',
    '- save <name> <address>: Save a Stellar contact',
    '- contacts: List saved contacts',
    '- send <amount> xlm <address-or-name>: Prepare an XLM transfer',
    '- yes: Confirm a pending transfer',
    '- no: Cancel a pending transfer',
    '',
    'Examples:',
    'save ada GABC...',
    'send 5 xlm ada',
  ].join('\n');
};

const handleCreateWallet = async (phoneNumber, user) => {
  try {
    const wallet = await createWalletForUser(user._id);
    await sendTextMessage(phoneNumber, `Creating and funding your new wallet on Stellar Testnet...`);

    await fundAccount(wallet.publicKey);

    await sendTextMessage(phoneNumber, `Wallet created and funded successfully.\n\nYour Public Key:\n${wallet.publicKey}\n\nYou can now check your balance.`);
  } catch (error) {
    if (error.message === 'User already has a wallet') {
      const existingWallet = await getWalletByUserId(user._id);
      await sendTextMessage(phoneNumber, `You already have a wallet.\n\nYour Public Key:\n${existingWallet.publicKey}`);
      return;
    }

    throw error;
  }
};

const handleBalance = async (phoneNumber, user) => {
  try {
    const wallet = await getWalletByUserId(user._id);
    if (!wallet) {
      await sendTextMessage(phoneNumber, `You don't have a wallet yet. Send 'create wallet' first.`);
      return;
    }

    const balance = await getBalance(wallet.publicKey);
    await sendTextMessage(phoneNumber, `Your current balance is ${balance} XLM`);
  } catch (error) {
    await sendTextMessage(phoneNumber, `Error getting balance: ${error.message}`);
  }
};

const handleSaveContact = async (phoneNumber, user, payload) => {
  try {
    const { alias, publicKey } = payload;
    if (!isValidPublicKey(publicKey)) {
      await sendTextMessage(phoneNumber, `That is not a valid Stellar public key. Please check the address and try again.`);
      return;
    }

    user.contacts = (user.contacts || []).filter((contact) => contact.alias !== alias);
    user.contacts.push({ alias, publicKey });
    await user.save();

    await sendTextMessage(phoneNumber, `Saved ${alias} as ${shortenPublicKey(publicKey)}.\n\nYou can now send with: send 5 xlm ${alias}`);
  } catch (error) {
    await sendTextMessage(phoneNumber, `Could not save contact: ${error.message}`);
  }
};

const handleListContacts = async (phoneNumber, user) => {
  if (!user.contacts || user.contacts.length === 0) {
    await sendTextMessage(phoneNumber, `You do not have saved contacts yet.\n\nUse: save <name> <stellar-address>`);
    return;
  }

  const contacts = user.contacts
    .map((contact) => `${contact.alias}: ${shortenPublicKey(contact.publicKey)}`)
    .join('\n');

  await sendTextMessage(phoneNumber, contacts);
};

const handlePrepareSend = async (phoneNumber, user, payload) => {
  try {
    const wallet = await getWalletByUserId(user._id);
    if (!wallet) {
      await sendTextMessage(phoneNumber, `You don't have a wallet yet. Send 'create wallet' first.`);
      return;
    }

    const { amount, recipient } = payload;
    const resolvedRecipient = resolveRecipient(user, recipient);

    if (!resolvedRecipient.destination) {
      await sendTextMessage(phoneNumber, `I could not find "${recipient}" in your contacts, and it is not a valid Stellar public key.\n\nUse: save ${recipient.toLowerCase()} GABC...`);
      return;
    }

    user.pendingSend = {
      amount,
      destination: resolvedRecipient.destination,
      alias: resolvedRecipient.alias,
      requestedAt: new Date(),
    };
    await user.save();

    const label = resolvedRecipient.alias || shortenPublicKey(resolvedRecipient.destination);
    await sendTextMessage(phoneNumber, `Confirm transfer:\n\nAmount: ${amount} XLM\nTo: ${label}\nAddress: ${resolvedRecipient.destination}\n\nReply YES to send or NO to cancel. This request expires in 10 minutes.`);
  } catch (error) {
    await sendTextMessage(phoneNumber, `Could not prepare transfer: ${error.message}`);
  }
};

const handleConfirmSend = async (phoneNumber, user) => {
  try {
    if (!user.pendingSend?.destination || isPendingSendExpired(user.pendingSend)) {
      user.pendingSend = undefined;
      await user.save();
      await sendTextMessage(phoneNumber, `No active transfer to confirm. Send a new command like: send 5 xlm GABC...`);
      return;
    }

    const wallet = await getWalletByUserId(user._id);
    if (!wallet) {
      await sendTextMessage(phoneNumber, `You don't have a wallet yet. Send 'create wallet' first.`);
      return;
    }

    const { amount, destination, alias } = user.pendingSend;
    await sendTextMessage(phoneNumber, `Processing your transfer of ${amount} XLM...`);

    const secretKey = decrypt(wallet.encryptedSecretKey);
    const txResponse = await sendXlm(secretKey, destination, amount);
    const explorerUrl = getTransactionUrl(txResponse.hash);

    await Transaction.create({
      userId: user._id,
      type: 'send',
      amount,
      asset: 'XLM',
      destination,
      txHash: txResponse.hash,
      explorerUrl,
      status: 'success',
    });

    user.pendingSend = undefined;
    await user.save();

    const label = alias || shortenPublicKey(destination);
    await sendTextMessage(phoneNumber, `Transfer successful.\n\nSent: ${amount} XLM\nTo: ${label}\nTransaction: ${txResponse.hash}\nReceipt: ${explorerUrl}`);
  } catch (error) {
    const pendingSend = user.pendingSend || {};
    await Transaction.create({
      userId: user._id,
      type: 'send',
      amount: pendingSend.amount || '0',
      destination: pendingSend.destination || 'unknown',
      status: 'failed',
    });

    user.pendingSend = undefined;
    await user.save();

    await sendTextMessage(phoneNumber, `Transfer failed: ${error.message}`);
  }
};

const handleCancelSend = async (phoneNumber, user) => {
  if (!user.pendingSend?.destination) {
    await sendTextMessage(phoneNumber, `No active transfer to cancel.`);
    return;
  }

  user.pendingSend = undefined;
  await user.save();
  await sendTextMessage(phoneNumber, `Transfer cancelled.`);
};

const resolveRecipient = (user, recipient) => {
  const normalizedRecipient = recipient.trim();
  const publicKey = normalizedRecipient.toUpperCase();

  if (isValidPublicKey(publicKey)) {
    return { destination: publicKey, alias: null };
  }

  const alias = normalizedRecipient.toLowerCase();
  const contact = (user.contacts || []).find((item) => item.alias === alias);
  if (!contact) {
    return { destination: null, alias };
  }

  return {
    destination: contact.publicKey,
    alias: contact.alias,
  };
};

const isPendingSendExpired = (pendingSend) => {
  if (!pendingSend.requestedAt) return true;
  return Date.now() - new Date(pendingSend.requestedAt).getTime() > PENDING_SEND_TTL_MS;
};

const shortenPublicKey = (publicKey) => {
  return `${publicKey.substring(0, 8)}...${publicKey.slice(-4)}`;
};

module.exports = {
  handleIncomingMessage,
};
