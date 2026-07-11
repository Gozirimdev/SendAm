# Architecture

This document describes how SendAm's backend is structured internally, and
the boundary between what ships in this open-source repository and what
runs as a privately-operated service.

## Wallets: Wallet-as-a-Service, not direct custody

SendAm does not generate or hold private keys itself. `apps/api/src/wallet/`
is a thin abstraction (`WalletService`) over a managed Wallet-as-a-Service
provider — Thirdweb Engine by default, with Openfort scaffolded as a
swappable alternative. Product code (payment orchestration, the WhatsApp
assistant, admin reporting) only ever calls `WalletService`; it never talks
to a provider SDK directly.

- Lisk is the primary settlement layer.
- Stellar is reserved for cross-border payment corridors, selected by
  `apps/api/src/blockchain/railSelector.js`.

An earlier direction explored direct key custody via a per-chain adapter
pattern (a `chains/` module with a `stellar.adapter.js` / `lisk.adapter.js`
interface, each user holding both a Stellar and a Lisk wallet). That
approach is not part of this codebase — the Wallet-as-a-Service model was
chosen instead so this repo never holds a private key that can move real
funds. It's preserved in git history on the `feat/multi-chain-foundation`
branch (tip commit `d770f2c`) if direct custody is ever revisited.

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
| Payment orchestration, rail selection | Full implementation | — |
| Managed wallets (Thirdweb/Openfort) | Full client | Custody, key management |
| Gas sponsorship (paymaster) | Thin client, calling contract only | Funded gas wallet, relayer signing |
| KYC | Tier/limit/risk-scoring logic | Provider identity verification (Smile ID / Dojah) |

## Why this shape

- **Reviewability.** The payment logic, rail selection, and compliance
  gating that decide what happens to a user's request are all in this
  open-source repo.
- **Safety.** Capabilities that hold real value (custody, a funded gas
  wallet) aren't distributed in a public repository's environment
  configuration — they're operated as services with their own access
  control.
- **Extensibility.** `railSelector.js` and `WalletService` are the seams for
  the next rail or the next provider — they slot in without touching
  unrelated code.
