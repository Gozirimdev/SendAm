// All user-facing WhatsApp copy lives here so handlers stay focused on logic
// and message wording is easy to find, tune, and (later) localize.

const shortenPublicKey = (publicKey) => `${publicKey.substring(0, 8)}...${publicKey.slice(-4)}`;

const replies = {
  greeting: (name) =>
    `Hello ${name || 'there'}! Welcome to SendAm. Reply with 'help' to see available commands.`,

  help: () =>
    [
      'Available commands:',
      '- create wallet: Create a new chain wallet',
      '- fund: Retry funding if your wallet was not funded',
      '- balance: Check your TOKEN balance',
      '- save <name> <address>: Save a chain contact',
      '- contacts: List saved contacts',
      '- send <amount> token <address-or-name>: Prepare an TOKEN transfer',
      '- yes: Confirm a pending transfer',
      '- no: Cancel a pending transfer',
      '',
      'Examples:',
      'save ada GABC...',
      'send 5 token ada',
    ].join('\n'),

  unknown: () => `Sorry, I didn't understand that. Reply with 'help' to see what I can do.`,
  genericError: (message) => `Sorry, an error occurred: ${message}`,
  rateLimited: () => `You're sending messages too quickly. Please wait a moment and try again.`,

  // Wallet
  creatingWallet: () => `Creating and funding your new wallet on chain Testnet...`,
  walletReady: (publicKey) =>
    `Wallet created and funded successfully.\n\nYour Public Key:\n${publicKey}\n\nYou can now check your balance.`,
  walletExists: (publicKey) => `You already have a wallet.\n\nYour Public Key:\n${publicKey}`,
  noWallet: () => `You don't have a wallet yet. Send 'create wallet' first.`,
  fundingWallet: () => `Funding your wallet on chain Testnet...`,
  fundingFailed: () =>
    `We couldn't fund your wallet right now — Testnet faucet may be busy. Reply 'fund' to try again in a moment.`,
  alreadyFunded: (publicKey) =>
    `Your wallet is already funded.\n\nYour Public Key:\n${publicKey}\n\nSend 'balance' to check it.`,

  // Balance
  balance: (amount) => `Your current balance is ${amount} TOKEN`,
  balanceError: (message) => `Error getting balance: ${message}`,
  insufficientBalance: (balance, amount) =>
    `Insufficient balance. You're trying to send ${amount} TOKEN but your balance is ${balance} TOKEN.`,

  // Contacts
  invalidPublicKey: () =>
    `That is not a valid chain public key. Please check the address and try again.`,
  contactSaved: (alias, publicKey) =>
    `Saved ${alias} as ${shortenPublicKey(publicKey)}.\n\nYou can now send with: send 5 token ${alias}`,
  contactSaveError: (message) => `Could not save contact: ${message}`,
  noContacts: () => `You do not have saved contacts yet.\n\nUse: save <name> <chain-address>`,
  contactList: (contacts) =>
    contacts.map((c) => `${c.alias}: ${shortenPublicKey(c.publicKey)}`).join('\n'),

  // Send
  invalidSendFormat: () =>
    `Invalid send format. Please use: send <amount> token <address-or-name>\nExample: send 5 token GABC...`,
  invalidSaveFormat: () =>
    `Invalid save format. Please use: save <name> <chain-address>\nExample: save ada GABC...`,
  recipientNotFound: (recipient) =>
    `I could not find "${recipient}" in your contacts, and it is not a valid chain public key.\n\nUse: save ${recipient.toLowerCase()} GABC...`,
  confirmTransfer: (amount, label, destination) =>
    `Confirm transfer:\n\nAmount: ${amount} TOKEN\nTo: ${label}\nAddress: ${destination}\n\nReply YES to send or NO to cancel. This request expires in 10 minutes.`,
  prepareError: (message) => `Could not prepare transfer: ${message}`,
  processingTransfer: (amount) => `Processing your transfer of ${amount} TOKEN...`,
  transferSuccess: (amount, label, txHash, explorerUrl) =>
    `Transfer successful.\n\nSent: ${amount} TOKEN\nTo: ${label}\nTransaction: ${txHash}\nReceipt: ${explorerUrl}`,
  transferFailed: (message) => `Transfer failed: ${message}`,
  noActiveTransfer: () => `No active transfer to confirm. Send a new command like: send 5 token GABC...`,
  transferCancelled: () => `Transfer cancelled.`,
  noTransferToCancel: () => `No active transfer to cancel.`,
};

module.exports = {
  replies,
  shortenPublicKey,
};
