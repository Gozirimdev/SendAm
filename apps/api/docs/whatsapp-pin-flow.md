# Secure PIN entry with WhatsApp Flows

## The problem

Until now the assistant said *"Reply with your PIN to send"* and the user typed
their payment PIN as an ordinary WhatsApp message. That PIN then lives:

- in the user's own chat history, forever, on every device they're signed into;
- in the business account's inbox, visible to anyone with WhatsApp Manager access;
- in Google Drive / iCloud chat backups;
- on the screen of anyone glancing at the phone, and in notification previews.

A four-digit secret that authorises spending, stored in plaintext in a chat
transcript, is the single worst exposure in the app. Deleting the message
afterwards does not reliably remove it from either side.

## The fix

A **WhatsApp Flow** is a native form rendered inside WhatsApp. Its contents are
never a chat message. The client generates a one-time AES key, encrypts the form
payload with it, encrypts that AES key to *this backend's* RSA public key, and
posts the result to our Flow endpoint. The conversation thread only ever shows
the confirmation bubble.

```
user taps "Confirm payment"
  └─> native form opens (PIN input, masked, input-type: passcode)
        └─> AES-GCM(payload) + RSA-OAEP(aes key)  ──POST──>  /webhook/flow
                                                                │
                                              decrypt, verify PIN, send payment
                                                                │
              form shows the result   <──encrypted response──────┘
```

The PIN exists only in memory in this process, for the duration of one HMAC
comparison. Nothing about it is written to the database or the message log.

## Setup

### 1. Generate the keypair

```bash
cd apps/api
node scripts/generate-flow-keys.js            # or --passphrase 'your-passphrase'
```

Set `WHATSAPP_FLOW_PRIVATE_KEY` (and `WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE` if
you used one) from the output. **Anyone holding this private key can decrypt
every PIN your users enter — treat it like any other signing secret.** It must
never be committed, logged, or shared.

### 2. Upload the public key to Meta

```bash
curl -X POST "https://graph.facebook.com/v19.0/$WHATSAPP_PHONE_NUMBER_ID/whatsapp_business_encryption" \
  -H "Authorization: Bearer $WHATSAPP_TOKEN" \
  --data-urlencode "business_public_key=$(cat public.pem)"
```

Verify with a `GET` on the same endpoint — the status must read `VALID`.

### 3. Create the Flow

In **WhatsApp Manager → Account tools → Flows → Create Flow**:

- Categories: `SIGN_IN` / `OTHER`
- Paste the contents of [`apps/api/flows/pin-confirm.flow.json`](../flows/pin-confirm.flow.json)
- Endpoint URI: `https://<your-api-host>/webhook/flow`
- Publish the Flow, then copy its **Flow ID** into `WHATSAPP_PIN_FLOW_ID`

The endpoint must already be deployed when you publish: Meta sends a `ping`
health check and refuses to publish a Flow whose endpoint doesn't answer it.

### 4. Verify

```bash
curl https://<your-api-host>/health/whatsapp
```

`pinFlow` should read `configured`. Then send yourself a payment from WhatsApp —
you should get a **Confirm payment** button rather than a "reply with your PIN"
prompt.

## Endpoint contract

Implemented in `src/controllers/flow.controller.js` and
`src/whatsapp/flow.crypto.js`. The status codes are part of Meta's contract:

| Status | Meaning |
| --- | --- |
| `200` | Encrypted response body (bare base64, **not** JSON) |
| `421` | We could not decrypt — Meta re-fetches the public key and retries |
| `432` | Request signature invalid (`verifyWhatsappSignature`) |
| `500` | Anything else; the user sees a generic error |

Two details that fail silently if you get them wrong:

- The response IV must be the request IV with **every bit inverted**.
- The response body is a bare base64 string with `Content-Type: text/plain`.

## Fallback behaviour

If `WHATSAPP_PIN_FLOW_ID` or `WHATSAPP_FLOW_PRIVATE_KEY` is unset, the assistant
falls back to the in-chat PIN prompt so sending still works in development —
with a loud warning in the logs and a warning appended to the user's message.

**Before handling real money, either configure the Flow or set
`ALLOW_IN_CHAT_PIN=false`.** With that set and no Flow configured, sends are
refused outright rather than confirmed insecurely.

Once a Flow *is* configured, a PIN typed into the chat is never accepted — the
assistant re-prompts and doesn't count it as an attempt, so a user who types
their PIN out of habit isn't also penalised for it.
