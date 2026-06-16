# SendAm

WhatsApp-first payments powered by the chain network.

SendAm is a financial access MVP that lets people create a chain wallet, check their TOKEN balance, and send TOKEN using simple WhatsApp messages. The goal is to make blockchain payments feel as familiar as sending a chat message, especially for users who may not be comfortable with browser wallets, seed phrases, or exchange-style interfaces.

## Live Links

- Web app: https://send-am-web.vercel.app/
- API: https://send-am-api.vercel.app/
- Repository: https://github.com/Gozirimdev/SendAm

> Current status: MVP running on chain Testnet. This repository is not yet configured for real-money production use.

## Why SendAm

Many people already understand WhatsApp, but crypto wallets still feel technical, intimidating, and risky. SendAm bridges that gap by turning WhatsApp into a simple payment interface while using chain for fast, low-cost settlement.

The product is designed for users who need:

- A familiar way to interact with digital money.
- Low-cost cross-border value transfer.
- Wallet creation without installing a separate crypto app.
- A lightweight payment experience that works well on mobile.
- An admin dashboard for monitoring users, wallets, and transactions.

## Why chain

chain is a strong fit for SendAm because the product needs fast settlement, low fees, simple account primitives, and a network designed for payments. In the MVP, chain Testnet is used to:

- Generate chain keypairs for new users.
- Fund test wallets through faucet.
- Read native TOKEN balances through rpc.
- Submit TOKEN payment transactions.
- Store transaction hashes for auditability and admin review.

The current implementation focuses on native TOKEN transfers first. The architecture can later support chain assets, anchors, fiat on/off ramps, and compliance-aware payment flows.

## Product Overview

SendAm has three main surfaces:

1. WhatsApp bot experience
   Users send natural commands to the bot, such as:

   ```text
   create wallet
   balance
   save ada GABC...
   contacts
   send 5 token ada
   send 5 token GABC...
   yes
   no
   help
   ```

2. REST API
   The backend exposes wallet and transaction endpoints so the product can be tested without WhatsApp.

3. Web admin dashboard
   Admins can view platform stats, users, wallets, and transaction records.

## Core Features

### User Features

- Create a chain Testnet wallet from a WhatsApp command.
- Automatically fund new test wallets using chain faucet.
- Check TOKEN balance by sending `balance`.
- Send TOKEN to another chain public address.
- Confirm transfers before funds are submitted to chain.
- Save contacts with aliases for repeat payments.
- Receive chain Expert receipt links after successful transfers.
- Receive simple WhatsApp replies for successful and failed actions.

### Admin Features

- View total users.
- View total wallets.
- View transaction counts.
- View successful and failed transactions.
- Browse user, wallet, and transaction tables.

### Developer Features

- REST endpoints for wallet creation, balance checks, and TOKEN transfers.
- MongoDB persistence for users, wallets, and transactions.
- Encrypted storage for chain references.
- Separate backend and frontend apps in one monorepo.

## Architecture

```text
WhatsApp User
     |
     v
WhatsApp Business API
     |
     v
Express Webhook API
     |
     +--> Command Parser
     +--> MongoDB: users, wallets, transactions
     +--> chain rpc: balances and payments
     |
     v
WhatsApp Response Message

Admin / Tester
     |
     v
Vite React Apps (landing + admin)
     |
     v
Express REST API
```

## Monorepo Structure

```text
SendAm/
  apps/
    api/       Express backend for WhatsApp, chain, MongoDB, and admin APIs
    landing/   Vite + React marketing/landing site
    admin/     Vite + React admin dashboard
  packages/
    shared/    Shared UI (Loader) and utilities (api client, formatDate)
  package.json Root workspace scripts
```

## Tech Stack

### Backend

- Node.js
- Express
- MongoDB with Mongoose
- chain SDK
- WhatsApp Business Cloud API
- Axios
- Helmet, CORS, Morgan, and rate limiting

### Frontend

- Vite + React (two apps: landing and admin)
- React Router
- Tailwind CSS
- Axios
- Lucide React icons

### Blockchain

- chain Testnet
- rpc API
- Native TOKEN payments
- faucet funding for test accounts

## How The Main Flow Works

### Wallet Creation

1. User sends `create wallet` on WhatsApp.
2. SendAm creates or finds the user by phone number.
3. Backend generates a chain keypair.
4. Reference is encrypted before storage.
5. Public key is stored on the wallet record.
6. Testnet wallet is funded with faucet.
7. User receives their public key by WhatsApp.

### Balance Check

1. User sends `balance`.
2. Backend finds the user's wallet.
3. Backend loads the account from chain rpc.
4. User receives current native TOKEN balance.

### TOKEN Transfer

1. User sends a command like `send 5 token GABC...` or `send 5 token ada`.
2. Backend parses amount and destination, or resolves a saved contact alias.
3. Backend sends a confirmation prompt to the user.
4. User replies `YES` to approve or `NO` to cancel.
5. Backend decrypts the user's stored chain reference.
6. Backend builds, signs, and submits a chain payment transaction.
7. Transaction result and chain Expert receipt link are saved in MongoDB.
8. User receives success or failure feedback on WhatsApp.

## API Summary

### Wallet API

Base path:

```text
/api/wallet
```

Endpoints:

```text
POST /api/wallet/create
GET  /api/wallet/:phone/balance
POST /api/wallet/send
```

### Admin API

Base path:

```text
/api/admin
```

Endpoints:

```text
GET /api/admin/stats
GET /api/admin/users
GET /api/admin/wallets
GET /api/admin/transactions
```

### WhatsApp Webhook

Base path:

```text
/webhook
```

Endpoints:

```text
GET  /webhook
POST /webhook
```

## Environment Variables

Create an `.env` file inside `apps/api` using `apps/api/.env.example` as a guide.

```env
PORT=3002
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/sendam
SERVICE_SECRET=your_64_character_hex_key
WHATSAPP_TOKEN=your_whatsapp_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_id_here
WHATSAPP_VERIFY_TOKEN=your_verify_token
CHAIN_NETWORK=testnet
CHAIN_HORIZON_URL=https://rpc-testnet.chain.org
```

For the admin app (`apps/admin/.env`), configure:

```env
VITE_API_BASE_URL=http://localhost:3002/api
```

For the landing app (`apps/landing/.env`), configure:

```env
VITE_ADMIN_URL=http://localhost:3001
```

## Getting Started

### Prerequisites

- Node.js 18 or newer
- npm
- MongoDB running locally or a MongoDB connection URI
- WhatsApp Business Cloud API credentials for webhook testing

### Install Dependencies

From the repository root:

```bash
npm install
```

### Run The Backend

```bash
npm run dev:api
```

The API runs on:

```text
http://localhost:3002
```

### Run The Frontend

```bash
npm run dev:landing
npm run dev:admin
```

The landing app runs on `http://localhost:3000` and the admin app on
`http://localhost:3001`.

### Run All Apps

```bash
npm run dev
```

This starts the API, landing, and admin apps together.

## Web App Pages

Landing app (`apps/landing`):

```text
/                 Landing page
```

Admin app (`apps/admin`):

```text
/login            Admin login screen
/                 Dashboard overview
/users            User table
/wallets          Wallet table
/transactions     Transaction table
```

## Security Notes

This project is still an MVP. Before any production or real-money launch, the following must be completed:

- Replace mock admin authentication with real backend authentication.
- Protect admin API routes with server-side authorization.
- Remove any fallback encryption key behavior.
- Validate chain public keys, amounts, phone numbers, and command payloads.
- Add transaction limits and abuse prevention.
- Add audit logs for sensitive actions.
- Add secure secret management for deployment.
- Complete legal, compliance, KYC, AML, and custody review where required.

## Current Limitations

- Uses chain Testnet only.
- Supports native TOKEN transfers only.
- WhatsApp command parser is intentionally simple.
- Admin login is currently mock/demo logic.
- No customer web signup is required yet because WhatsApp phone number is the MVP identity.
- No production compliance workflow is included yet.

## Roadmap

### MVP Completion

- Real admin authentication.
- Stronger validation for wallet and payment requests.
- Better WhatsApp command handling, confirmation prompts, and error messages.
- Automated tests for parser, wallet, webhook, and transaction flows.
- Deployment configuration for backend, frontend, database, and environment variables.

### chain Product Expansion

- Support custom chain assets.
- Expand contact aliases into richer recipient management.
- Add richer transaction receipts with chain explorer links.
- Add QR-code public key sharing.
- Add low-balance warnings and safer confirmation flows.
- Explore anchor integrations for fiat on/off ramps.

### Production Readiness

- Compliance review.
- Monitoring and alerting.
- Admin roles and permissions.
- Recovery and support workflows.
- Rate limits per user and per phone number.
- Secure key-management strategy.

## Reviewer's Summary

SendAm demonstrates a practical chain use case: making blockchain payments accessible through a communication channel people already use every day. The MVP combines WhatsApp, chain Testnet, MongoDB, and a Next.js admin dashboard to show the foundation for a chat-based payment product.

The project is intentionally scoped: it proves wallet creation, balance checks, saved recipients, confirmation-based TOKEN transfers, and auditable chain receipts first. With stronger authentication, validation, compliance work, and production deployment, SendAm can evolve from a Testnet MVP into a broader payments product for mobile-first users.

## License

SendAm is open source and released under the MIT License. See `LICENSE` for details.

## Contributing

Contributions are welcome. See `CONTRIBUTING.md` for setup instructions, contribution areas, pull request guidelines, and security notes.
