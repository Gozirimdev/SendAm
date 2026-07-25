const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

process.env.WHATSAPP_FLOW_PRIVATE_KEY = privateKey;
process.env.WHATSAPP_PIN_FLOW_ID = '1234567890';

const flowCrypto = require('../src/whatsapp/flow.crypto');

// Stands in for the WhatsApp client: mints a one-time AES key, encrypts the
// payload with AES-GCM, and seals the key to our public key with RSA-OAEP.
const buildEncryptedRequest = (payload) => {
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    body: {
      encrypted_aes_key: crypto
        .publicEncrypt(
          { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          aesKey
        )
        .toString('base64'),
      encrypted_flow_data: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64'),
      initial_vector: iv.toString('base64'),
    },
    aesKey,
    iv,
  };
};

test('decryptRequest recovers the submitted payload', () => {
  const payload = { version: '3.0', action: 'data_exchange', screen: 'CONFIRM_PIN', data: { pin: '1234' }, flow_token: 'tok' };
  const { body } = buildEncryptedRequest(payload);

  const result = flowCrypto.decryptRequest(body);
  assert.deepStrictEqual(result.payload, payload);
  assert.strictEqual(result.aesKey.length, 16);
});

// Meta requires the response IV to be the request IV with every bit flipped.
// Getting this wrong makes the client silently discard every response.
test('encryptResponse uses the bitwise-inverted IV and round-trips', () => {
  const { body, aesKey, iv } = buildEncryptedRequest({ action: 'ping' });
  const { aesKey: derivedKey, iv: derivedIv } = flowCrypto.decryptRequest(body);

  const response = { data: { status: 'active' } };
  const encrypted = flowCrypto.encryptResponse(response, derivedKey, derivedIv);

  // Decrypt the way the WhatsApp client would.
  const flipped = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i += 1) flipped[i] = ~iv[i] & 0xff;

  const raw = Buffer.from(encrypted, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, flipped);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(raw.subarray(0, raw.length - 16)),
    decipher.final(),
  ]).toString('utf8');

  assert.deepStrictEqual(JSON.parse(plaintext), response);
});

test('invertIv flips every bit', () => {
  const iv = Buffer.from([0x00, 0xff, 0xa5]);
  assert.deepStrictEqual([...flowCrypto.invertIv(iv)], [0xff, 0x00, 0x5a]);
});

// A key mismatch must surface as FlowKeyError so the controller can answer 421
// and have Meta re-fetch the public key, rather than 500 and mark us broken.
test('decryptRequest raises FlowKeyError when the key does not match', () => {
  const other = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const { body } = buildEncryptedRequest({ action: 'ping' });
  body.encrypted_aes_key = crypto
    .publicEncrypt(
      { key: other.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      crypto.randomBytes(16)
    )
    .toString('base64');

  assert.throws(() => flowCrypto.decryptRequest(body), flowCrypto.FlowKeyError);
});

test('decryptRequest rejects a body missing required fields', () => {
  assert.throws(() => flowCrypto.decryptRequest({}), /missing encrypted_aes_key/);
});

test('configured() reflects both required env vars', () => {
  assert.strictEqual(flowCrypto.configured(), true);
});
