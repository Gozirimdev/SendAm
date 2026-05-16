require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3002,
  env: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/sendam',
  encryptionKey: process.env.SERVICE_SECRET,
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  },
  chain: {
    network: process.env.CHAIN_NETWORK || 'testnet',
    rpcUrl: process.env.CHAIN_HORIZON_URL || 'https://rpc-testnet.chain.org',
  }
};
