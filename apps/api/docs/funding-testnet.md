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
| [thirdweb](https://thirdweb.com/lisk-sepolia-testnet) | 0.01 ETH per claim from the chain page's Faucet section. |
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

```bash
node scripts/create-gas-wallet.js
```

This generates a key, stores it encrypted (AES-256-GCM under `ENCRYPTION_KEY`)
as a `Wallet` row owned by a reserved system user, and prints the address. Then:

1. Set `LISK_GAS_WALLET_ADDRESS` to the printed address.
2. Fund it with ETH from the [Superchain Faucet](https://console.optimism.io/faucet).
3. Back up the printed private key — it is the only copy outside the database.

Any user wallet below `LISK_GAS_MIN_BALANCE` (default `0.00005` ETH, ~500
transfers) is refilled to `LISK_GAS_TOPUP_TO` (default `0.0002` ETH, ~2000
transfers) before its transfer is submitted.

If the gas wallet runs dry, the send fails with `GAS_WALLET_EMPTY` naming the
address and the shortfall, rather than surfacing as an opaque revert on a user's
payment.

## Going to mainnet

Recheck every address here. Lisk mainnet is chain `1135` with a different USDC
contract, and the faucets above are testnet-only. `LISK_NATIVE_SYMBOL` stays
`ETH` — mainnet Lisk also pays gas in ETH.
