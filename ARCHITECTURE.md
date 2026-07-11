# Architecture

This document describes how SendAm's backend is structured internally, and
the boundary between what ships in this open-source repository and what
runs as a privately-operated service.

## Wallets: wallet mapping via a chain-adapter pattern

SendAm generates and holds each user's keys itself — there is no managed
wallet provisioning provider in the loop. Blockchain-specific logic is
isolated behind a small adapter interface in `apps/api/src/wallet/`:

```js
{
  chain,                                  // 'chain' | 'lisk'
  createWallet(),                         // -> { publicKey, secretKey }
  getBalance(publicKey),                  // -> native-asset balance
  submitPayment({ secretKey, destination, amount, asset }),
  resolveAsset(assetCode),
  validateAddress(address),
  fundTestnetAccount(publicKey),          // testnet-only convenience
}
```

Each supported chain implements this interface once (`chain.reader.js`,
`lisk.reader.js`); `account.service.js` resolves the right one via
`chainIndex.js` and never imports a chain SDK directly. Adding a new
chain means writing one adapter, not touching product logic.

Destination chain is inferred from address shape (a chain `G...` AddressCodec
vs. an EVM `0x...` address), so a user never has to declare which chain
they mean — every user gets both a chain and a Lisk wallet by default,
and `send` routes automatically (`payment.orchestrator.js` detects the
chain from the destination before rail selection).

References are encrypted (authenticated encryption, `services/secretStore.js`)
before being stored in the `Wallet` table (one row per user per chain) —
plaintext keys never leave `account.service.js`.

An earlier direction explored managed custody via Provider Engine /
Vendor (wallet provisioning). That approach is not part of this codebase —
wallet mapping was chosen instead so wallet behavior (funding, native-asset
transfers) isn't dependent on a third-party provider's API.

- Lisk is the primary settlement layer.
- chain is reserved for cross-border payment corridors, selected by
  `apps/api/src/blockchain/railSelector.js`.

## What's open vs. what's a private service

Everything that makes SendAm's payment flow work is in this repository:
wallet creation, balance checks, payment orchestration, rail selection, the
WhatsApp command flow, compliance/KYC gating, escrow, and the admin
dashboard. A few capabilities depend on infrastructure that has to run
privately — holding real funds, or credentials that shouldn't ship in a
public repo — and this repo only contains a thin, well-defined client for
them, degrading gracefully (clearly logged, no crash) when unconfigured.

| Capability | In this repo | Runs privately |
|---|---|---|
| chain wallet / balance / send | Full implementation | — |
| Lisk wallet / balance / send | Full implementation | — |
| Payment orchestration, rail selection | Full implementation | — |
| Gas sponsorship (paymaster) | Thin client, calling contract only | Funded gas wallet, relayer signing |
| KYC | Tier/limit/risk-scoring logic | Provider identity verification (Smile ID / Dojah) |

## Why this shape

- **Reviewability.** Anyone can read exactly how SendAm talks to chain and
  Lisk and decides what happens to a payment, because that code is the
  whole point of being open source here.
- **Safety.** Capabilities that hold real value (a funded gas wallet)
  aren't distributed in a public repository's environment configuration —
  they're operated as services with their own access control. Wallet
  private keys stay encrypted at rest and are only ever decrypted inside
  `account.service.js` for the duration of a signing operation.
- **Extensibility.** The adapter interface and `railSelector.js` are the
  seams for the next chain or the next rail — they slot in without
  touching unrelated code.
