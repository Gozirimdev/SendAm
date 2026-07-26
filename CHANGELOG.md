# Changelog

All notable changes to SendAm are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Code of Conduct (Contributor Covenant 2.1).
- Unit tests for transfer guardrails, recipient resolution, and request
  validators.
- Multi-token balance view: the `balance` command lists every token a wallet
  holds, with naira values, falling back to a direct on-chain USDC read if the
  explorer is unavailable.
- Transfer preflight that distinguishes "not enough USDC" from "not enough ETH
  for gas" before submitting, so the user is told which one it actually was.
- `GET /health/lisk` diagnostic that reports which step of a balance lookup
  fails (env, RPC reachability, contract, read), for diagnosing a deployment
  without shell access.
- In-chat testnet funding: "fund me" drips test USDC from a platform treasury,
  topping up gas in the same step.

### Changed

- **Wallet signing keys are no longer held by this service.** They are
  generated, stored, and used only inside a private custody service, which this
  API reaches over HMAC-authenticated HTTP. The API now holds no key material,
  has no way to decrypt any, and the `Wallet` table has no column for one.
  Requires `CUSTODY_BASE_URL` and `CUSTODY_SIGNING_SECRET`.
- Transfers now carry an idempotency key (the transaction id), so a replayed
  request cannot become a second on-chain transfer.
- Every on-chain route settles on Lisk. The separate cross-border rail was
  removed — nothing executed behind it, so routing to it produced a payment that
  silently never landed. Cross-border is still tracked as a distinct `routeType`
  for compliance limits, derived from the countries rather than the rail.
- Onboarding is a browser step: a single-use expiring link collects a name,
  terms acceptance, and a PIN (plus an optional passkey) before the wallet is
  provisioned.
- HTTP request logging now uses the `combined` Morgan format in production
  (`dev` elsewhere) for production-grade access logs.
- Prisma migrations were squashed to a single baseline; databases created before
  it must be reset.

### Removed

- The fixed command vocabulary of the original wallet bot. None of it was
  reachable — conversational intent handling replaced it.

## [1.0.0]

### Added

- WhatsApp-first wallet experience with a confirmation flow for transfers.
- Balance checks and payments on-chain, with explorer receipt links stored for
  auditability.
- Saved recipient aliases for repeat payments.
- Confirmation-based transfers with an upfront balance check and a 10-minute
  pending-transfer expiry.
- Admin dashboard (Vite + React) for users, wallets, and transactions, with
  server-side pagination.
- REST API for wallet creation, balance, and transfers (unauthenticated;
  disabled in production by default via `ENABLE_WALLET_REST_API`).

### Security

- Admin authentication via HMAC-signed, expiring session tokens; the API refuses
  to start without `ADMIN_PASSWORD` and `JWT_SECRET`.
- WhatsApp webhook signature verification against `X-Hub-Signature-256`
  (fail-closed in production).
- Inbound message idempotency to prevent duplicate transfers from webhook
  retries.
- Per-user transfer guardrails: per-transaction cap plus rolling 24h amount and
  count limits.
- CORS allowlist enforced in production and PostgreSQL-backed rate limiting
  shared across instances.

### Operations

- `GET /health` readiness probe (503 when the database link is down).
- Graceful shutdown that drains in-flight requests before exit.
- Continuous integration: backend tests plus frontend lint and build on every
  pull request.

[Unreleased]: https://github.com/Gozirimdev/SendAm/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Gozirimdev/SendAm/releases/tag/v1.0.0
