# Funding SendAm on Lisk Sepolia

## The one thing to get right

**Gas on Lisk is paid in ETH, not LSK.**

Lisk is an OP Stack L2, so it inherits Ethereum's native currency. LSK exists on
Lisk as an *ordinary ERC-20 token* — holding it does nothing for your ability to
transact, exactly like holding USDC doesn't. Verified on-chain: the WETH9
predeploy at `0x4200000000000000000000000000000000000006` reports "Wrapped
Ether", and LSK resolves to ERC-20 contracts such as
`0x8a21CF9Ba08Ae709D64Cb25AfAA951183EC9FF6D`.

A wallet showing `0.1 LSK` and `0 ETH` cannot send anything.

## What a transfer actually costs

Measured against `rpc.sepolia-api.lisk.com`:

| Component | Cost |
| --- | --- |
| L2 gas price | ~0.001 gwei (the floor) |
| ERC-20 transfer, L2 execution (65k gas) | 0.000000065 ETH |
| L1 data fee (OP Stack surcharge) | 0.000000023 ETH |
| **Total** | **~0.0000001 ETH** |

**0.01 ETH is roughly 100,000 transfers.** One faucet claim funds the whole
testnet deployment indefinitely.

## Getting ETH (for gas)

| Source | Notes |
| --- | --- |
| [Superchain Faucet](https://console.optimism.io/faucet) | Supports Lisk Sepolia directly. Up to 0.2 ETH/day with onchain identity auth. **Easiest.** |
| [provider](https://provider.com/lisk-sepolia-testnet) | 0.01 ETH per claim from the chain page's Faucet section. |
| [L2 Faucet](https://www.l2faucet.com/lisk) | Device attestation, no bridging. *Was under maintenance at time of writing.* |
| Bridge | Get Sepolia ETH ([Chainlink faucet](https://faucets.chain.link/sepolia)), then bridge via [sepolia-bridge.lisk.com](https://sepolia-bridge.lisk.com/). |

## Getting USDC.e (to send)

The configured token is `0x0E82fDDAd51cc3ac12b69761C45bBCB9A2Bf3C83` —
**"Bridged USDC (Lisk Sepolia Testnet)"**, symbol `USDC.e`, 6 decimals. It is a
Circle `FiatTokenProxy` with no public mint.

**There is no direct USDC faucet on Lisk Sepolia.** Confirmed two ways: Circle's
faucet lists 40+ networks and Lisk is not among them, and every mint of this
token on-chain arrives via `0x4200000000000000000000000000000000000007`
(L2CrossDomainMessenger, `relayMessage`) — i.e. bridged in from L1.

So the route is two steps:

1. **Claim testnet USDC on Ethereum Sepolia** — [faucet.circle.com](https://faucet.circle.com/),
   20 USDC every 2 hours per address, no account needed.
2. **Bridge it to Lisk Sepolia** — either the web bridge at
   [sepolia-bridge.lisk.com](https://sepolia-bridge.lisk.com/), or from the terminal:

```bash
export SEPOLIA_PRIVATE_KEY=0x...          # never pass this as an argument
node scripts/bridge-usdc-to-lisk.js --amount 20                          # dry run
node scripts/bridge-usdc-to-lisk.js --amount 20 --confirm                # execute
node scripts/bridge-usdc-to-lisk.js --amount 20 --to 0xUserWallet --confirm
```

Either way you need a little Sepolia ETH to pay for the deposit transaction.

### How the USDC bridge actually works

USDC.e is Circle's Bridged USDC Standard, **not** an `OptimismMintableERC20` —
`l1Token()` and `remoteToken()` both revert on it, so the L2StandardBridge
cannot mint it and the generic OP bridge path does not apply. Deposits go
through a dedicated adapter pair:

| | |
| --- | --- |
| L1 adapter (Ethereum Sepolia) | `0x8454EAd8e8B6D63951033F38D61A5F0AC6f40279` |
| L2 adapter (Lisk Sepolia) | `0x45c01066E6b913D2EF4ad48E3629E66Ae41904b1` |
| L1 USDC (what Circle's faucet gives you) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

The flow is `USDC.approve(L1_ADAPTER, amount)` then
`L1_ADAPTER.sendMessage(to, amount, minGasLimit)`; the L2 side is minted via
`L2CrossDomainMessenger.relayMessage` → `receiveMessage(address,address,uint256)`
on the L2 adapter, usually within a few minutes.

The script re-checks the adapter's own `USDC()` and `LINKED_ADAPTER()` on-chain
before granting any approval, so a wrong or substituted address fails loudly
instead of sending funds somewhere unrecoverable.

Sanity-check the result at any point:

```bash
node scripts/check-wallet-funding.js 0xYourWallet     # or a phone number
```

It reports the USDC.e balance, the ETH balance, the live per-transfer cost, and
which of the two is missing.

## Automatic gas top-ups (no paymaster needed)

Users should never have to think about gas. `payment/gasTopup.js` refills a
sending wallet before every transfer.

`sendam-paymaster` does this when configured, but it is **optional** — a funded
gas wallet is enough on its own:

Ask the custody service for the reserved system wallet — it mints one on first
request and returns the same address on every later one:

```bash
curl -X POST "$CUSTODY_BASE_URL/wallets" \
  -H 'Content-Type: application/json' \
  -H "x-sendam-signature: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$CUSTODY_SIGNING_SECRET" -hex | awk '{print $2}')" \
  -H "x-sendam-timestamp: $(date +%s)" \
  -d "$BODY"     # BODY='{"ref":"system:lisk-gas-wallet","chain":"lisk"}'
```

Then:

1. Set `LISK_GAS_WALLET_ADDRESS` to the returned address.
2. Fund it with ETH from the [Superchain Faucet](https://console.optimism.io/faucet).

There is no private key to back up here — it never leaves the custody service,
whose database is the thing that needs backing up.

Any user wallet below `LISK_GAS_MIN_BALANCE` (default `0.00005` ETH, ~500
transfers) is refilled to `LISK_GAS_TOPUP_TO` (default `0.0002` ETH, ~2000
transfers) before its transfer is submitted.

If the gas wallet runs dry, the send fails with `GAS_WALLET_EMPTY` naming the
address and the shortfall, rather than surfacing as an opaque revert on a user's
payment.

## Funding a user with no backend access (start here)

If you don't control the API deployment you cannot set env vars, so the in-chat
faucet below is not available to you. Fund users directly from your own wallet
instead — no deploy and no central gas payer:

```bash
export FUNDER_PRIVATE_KEY=0x...       # your MetaMask key, never in a file
npm run fund:user -- +2348012345678                  # dry run, shows what it would do
npm run fund:user -- +2348012345678 --confirm        # gas + 10 USDC
npm run fund:user -- +2348012345678 --usdc 20 --confirm
npm run fund:user -- +2348012345678 --gas-only --confirm
```

It looks the user up by phone number, sends them gas on Lisk, and bridges them
USDC — and only ever reads the `address` column, so the user's own key stays
sealed in the database.

You need, in your own wallet:

| For | Get it from |
| --- | --- |
| Gas to hand out (Lisk Sepolia ETH) | [console.optimism.io/faucet](https://console.optimism.io/faucet) → Lisk Sepolia |
| USDC to hand out (Ethereum Sepolia) | [faucet.circle.com](https://faucet.circle.com/) → Ethereum Sepolia |
| Sepolia ETH, to pay for the bridge tx | [faucets.chain.link/sepolia](https://faucets.chain.link/sepolia) |

**Users pay their own gas.** With no `LISK_GAS_WALLET_ADDRESS` set, `ensureGas`
no-ops and a transfer draws gas from the sender's own wallet — which is exactly
what the ETH above is for. There is no central gas payer unless someone
deliberately configures one.

## Letting users fund themselves ("fund me")

Users **cannot** do the faucet-and-bridge dance above: their wallet key is
generated by this backend and stored encrypted, and is never handed out. So
funding a tester previously meant an operator doing it for them, by hand, per
person.

This is the option **if you control the deployment** — it needs a treasury
address set as an env var. Without that access, use the direct funding above.

The operator funds one treasury and users ask the bot:

```
user:  fund me
bot:   Sent you 10 test USDC — it's in your wallet now.
       Say "balance" to see it, or try sending some to a friend.
```

Gas is topped up in the same step, since USDC.e you cannot afford to move is no
use.

### Setup

The treasury is provisioned on demand: the first "fund me" asks the custody
service for the reserved `system:lisk-gas-wallet` ref and stores the address it
returns. Because custody is idempotent on that ref, this cannot produce two
treasuries even if several requests arrive together — so there is no wrong-key
failure mode and nothing to run by hand.

Check what is and isn't configured at any time:

```bash
curl https://<your-api-host>/health/features
```

The treasury defaults to the gas wallet, so if one already exists there is
nothing new to create — just put USDC.e in it:

```bash
node scripts/bridge-usdc-to-lisk.js --amount 100 --to <treasury address> --confirm
```

Set `LISK_FAUCET_WALLET_ADDRESS` only if you want the faucet treasury separate
from the gas wallet.

### Guard rails

| Control | Default | Env |
| --- | --- | --- |
| Per claim | 10 USDC.e | `TESTNET_FAUCET_AMOUNT` |
| Cooldown | 24 hours | `TESTNET_FAUCET_COOLDOWN_HOURS` |
| Lifetime cap per user | 5 claims | `TESTNET_FAUCET_MAX_PER_USER` |
| Kill switch | on | `TESTNET_FAUCET_ENABLED=false` |

**Hard-gated to testnet chain ids in code, independent of every setting above.**
On Lisk mainnet (1135) it refuses to run at all — otherwise it would be an open
drain on real funds for anyone able to send a WhatsApp message.

Every drip is written to the `Transaction` table as `faucet_drip`, which is both
the cooldown source and the audit trail for where treasury funds went. An empty
treasury logs the exact refill command and tells the user to try later, rather
than failing mid-transfer.

## Going to mainnet

Recheck every address here. Lisk mainnet is chain `1135` with a different USDC
contract, and the faucets above are testnet-only. `LISK_NATIVE_SYMBOL` stays
`ETH` — mainnet Lisk also pays gas in ETH.
