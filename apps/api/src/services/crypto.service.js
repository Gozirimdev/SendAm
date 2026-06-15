const crypto = require('crypto');
const config = require('../config/env');

const IV_LENGTH = 16;
// aes-256-cbc needs a 32-byte key. ENCRYPTION_KEY must be a 64-char hex
// string. No fallback: a missing/short key must fail loudly rather than
// silently encrypt wallet secrets with a guessable default.
if (!config.encryptionKey || Buffer.from(config.encryptionKey, 'hex').length !== 32) {
  throw new Error('ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). Generate one with: openssl rand -hex 32');
}
const ENCRYPTION_KEY = Buffer.from(config.encryptionKey, 'hex');

const encrypt = (text) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decrypt = (text) => {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
};

module.exports = {
  encrypt,
  decrypt
};
