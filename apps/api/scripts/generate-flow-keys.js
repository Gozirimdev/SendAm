#!/usr/bin/env node
/**
 * Generates the RSA-2048 keypair a WhatsApp Flow endpoint needs.
 *
 * The public half is uploaded to Meta (it encrypts each Flow's one-time AES
 * key to it); the private half stays in WHATSAPP_FLOW_PRIVATE_KEY and is the
 * only thing that can read a submitted PIN. Anyone holding the private key can
 * decrypt every PIN your users enter — treat it exactly like SERVICE_SECRET.
 *
 *   node scripts/generate-flow-keys.js                 # unencrypted key
 *   node scripts/generate-flow-keys.js --passphrase X  # passphrase-protected
 *
 * Prints the public key to upload and the escaped single-line private key to
 * paste into a hosting dashboard's env editor.
 */
const crypto = require('crypto');

const args = process.argv.slice(2);
const passphraseIndex = args.indexOf('--passphrase');
const passphrase = passphraseIndex !== -1 ? args[passphraseIndex + 1] : undefined;

if (passphraseIndex !== -1 && !passphrase) {
  console.error('--passphrase needs a value.');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: passphrase
    ? { type: 'pkcs8', format: 'pem', cipher: 'legacy encryption', passphrase }
    : { type: 'pkcs8', format: 'pem' },
});

console.log('=== PUBLIC KEY — upload to Meta ===\n');
console.log(publicKey);
console.log('Upload with:\n');
console.log(
  '  curl -X POST "https://graph.facebook.com/v19.0/$WHATSAPP_PHONE_NUMBER_ID/whatsapp_business_encryption" \\\n' +
    '    -H "Authorization: Bearer $WHATSAPP_TOKEN" \\\n' +
    '    --data-urlencode "business_public_key=$(cat public.pem)"\n'
);

console.log('=== PRIVATE KEY — set as WHATSAPP_FLOW_PRIVATE_KEY, never commit ===\n');
console.log(privateKey);
console.log('Single-line form for env dashboards that reject newlines:\n');
console.log(privateKey.replace(/\n/g, '\\n'));
if (passphrase) {
  console.log('\nAlso set WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE to the passphrase you supplied.');
}
