const crypto = require('crypto');
const config = require('../config/env');

// Endpoint encryption for WhatsApp Flows.
//
// A Flow is a native form rendered inside WhatsApp. What the user types there
// never becomes a chat message: the client generates a one-time AES key,
// encrypts the form payload with it, encrypts that key to *our* RSA public key,
// and posts the result to this backend. The PIN therefore never exists in the
// conversation thread, in either party's chat backup, or in Meta's message
// store — which is exactly the exposure we have while PINs are typed as
// ordinary chat messages.
//
// Scheme (Meta's spec, not negotiable — every field is fixed on their side):
//   encrypted_aes_key  : AES key, RSA-OAEP(SHA-256) to our public key, base64
//   encrypted_flow_data: AES-GCM ciphertext with a 16-byte tag appended, base64
//   initial_vector     : the GCM IV, base64
// The response is encrypted with the *same* AES key and the bitwise-inverted
// IV, and returned as a bare base64 string with a 200.

const TAG_LENGTH = 16;

const configured = () => Boolean(config.whatsapp.flowPrivateKey && config.whatsapp.pinFlowId);

// Thrown when the body can't be decrypted with our current key. The caller
// must answer HTTP 421 so Meta re-fetches the public key and retries — any
// other status makes it treat the Flow endpoint as broken.
class FlowKeyError extends Error {}

const privateKey = () => {
  if (!config.whatsapp.flowPrivateKey) {
    throw new FlowKeyError('WHATSAPP_FLOW_PRIVATE_KEY is not set.');
  }
  try {
    return crypto.createPrivateKey({
      key: config.whatsapp.flowPrivateKey,
      passphrase: config.whatsapp.flowPrivateKeyPassphrase || undefined,
    });
  } catch (error) {
    throw new FlowKeyError(`WHATSAPP_FLOW_PRIVATE_KEY could not be loaded: ${error.message}`);
  }
};

// GCM cipher name follows the key Meta chose (128-bit today), rather than
// hardcoding aes-128-gcm and breaking if they ever widen it.
const cipherName = (aesKey) => `aes-${aesKey.length * 8}-gcm`;

const decryptRequest = (body) => {
  const { encrypted_aes_key: encryptedAesKey, encrypted_flow_data: encryptedFlowData, initial_vector: initialVector } = body || {};
  if (!encryptedAesKey || !encryptedFlowData || !initialVector) {
    throw new Error('Flow request is missing encrypted_aes_key, encrypted_flow_data or initial_vector.');
  }

  let aesKey;
  try {
    aesKey = crypto.privateDecrypt(
      { key: privateKey(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(encryptedAesKey, 'base64')
    );
  } catch (error) {
    if (error instanceof FlowKeyError) throw error;
    // The stored private key doesn't match the public key Meta encrypted to.
    throw new FlowKeyError(`Could not decrypt the Flow AES key: ${error.message}`);
  }

  const payload = Buffer.from(encryptedFlowData, 'base64');
  const iv = Buffer.from(initialVector, 'base64');
  const ciphertext = payload.subarray(0, payload.length - TAG_LENGTH);
  const authTag = payload.subarray(payload.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(cipherName(aesKey), aesKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

  return { payload: JSON.parse(plaintext), aesKey, iv };
};

// Meta requires the response IV to be the request IV with every bit flipped.
// Buffer#map returns a plain Uint8Array, so build the buffer explicitly.
const invertIv = (iv) => {
  const flipped = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i += 1) flipped[i] = ~iv[i] & 0xff;
  return flipped;
};

const encryptResponse = (response, aesKey, iv) => {
  const cipher = crypto.createCipheriv(cipherName(aesKey), aesKey, invertIv(iv));
  return Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
};

module.exports = {
  configured,
  decryptRequest,
  encryptResponse,
  invertIv,
  FlowKeyError,
};
