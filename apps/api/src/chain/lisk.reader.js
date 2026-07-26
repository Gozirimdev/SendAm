const { ethers } = require('ethers');
const config = require('../config/env');

// Read-only view of the Lisk chain: balances, token listings, transfer
// preflight, and health. No signing and no keys — those live in
// sendam-custody, which is the only process that holds them. Everything here
// talks to public endpoints about public data, which is why it can stay in
// this repo.

// Minimal ERC-20 surface: this is all we call against the USDC contract on Lisk.
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

// Lisk chain ids: Sepolia testnet = 4202, mainnet = 1135. LISK_CHAIN_ID
// defaults to the string 'lisk' (see config/env.js), which is not numeric, so
// fall back to the testnet id rather than let ethers auto-detect.
const LISK_DEFAULT_CHAIN_ID = 4202;
const resolvedChainId = () => Number(config.lisk.chainId) || LISK_DEFAULT_CHAIN_ID;

let cachedProvider;
const provider = () => {
  if (!config.lisk.rpcUrl) {
    throw new Error('Lisk RPC is not configured. Set LISK_RPC_URL.');
  }
  if (!cachedProvider) {
    // staticNetwork pins the chain id so ethers skips the eth_chainId
    // network-detection round-trip it otherwise fires on the first call.
    // That detection call is the first RPC touch in a balance lookup, and
    // against the public Lisk endpoint it intermittently times out on cold
    // start — surfacing to the user as "Couldn't fetch your balance right
    // now". Pinning removes that hop.
    cachedProvider = new ethers.JsonRpcProvider(config.lisk.rpcUrl, undefined, {
      staticNetwork: ethers.Network.from(resolvedChainId()),
    });
  }
  return cachedProvider;
};

// One retry on transient RPC failures (timeouts, dropped connections). The
// public Lisk endpoint occasionally drops a cold request that succeeds on an
// immediate retry; a single retry turns that flake into a non-event without
// masking a genuinely-down RPC (which fails both attempts).
const withRetry = async (fn, attempts = 2) => {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

const getBalance = async ({ address, tokenAddress = config.lisk.usdcContractAddress }) => {
  if (!tokenAddress) {
    throw new Error('Token contract address is required to read a balance.');
  }
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider());
  const [raw, decimals] = await withRetry(() =>
    Promise.all([token.balanceOf(address), token.decimals()])
  );
  return { value: ethers.formatUnits(raw, decimals), raw: raw.toString(), decimals };
};

// Raw JSON-RPC POST that, unlike ethers, surfaces the HTTP status and a
// snippet of a non-JSON body. ethers collapses "the endpoint returned an HTML
// 429/502/challenge page" into an opaque "response body is not valid JSON",
// which hides exactly the detail needed to tell a rate-limited/blocked host IP
// from a wrong RPC URL. This does not decode results — it only reports what the
// endpoint actually sent back.
const rawRpcProbe = async (method, params = []) => {
  const response = await fetch(config.lisk.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(
      `HTTP ${response.status} returned non-JSON body: "${snippet}" — endpoint is not serving JSON-RPC (rate-limit/proxy/challenge page, or wrong LISK_RPC_URL)`
    );
  }
  if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  return json.result;
};

// Diagnostic used by the /health/lisk route. Walks the exact call path
// getBalance() takes — env presence, real RPC connectivity, contract existence,
// a real balanceOf — and reports which step fails, so a locked-out operator can
// tell "envs missing on the deploy host" from "RPC is rate-limited/blocked"
// over HTTP without shell access. Never throws; always resolves to a status
// object. `rpcHost` is echoed so a wrong deployed LISK_RPC_URL is visible.
const checkHealth = async () => {
  const result = { ok: false, envs: null, rpcHost: null, rpc: null, contract: null, balanceRead: null };

  result.envs = Boolean(config.lisk.rpcUrl) && Boolean(config.lisk.usdcContractAddress);
  if (!config.lisk.rpcUrl) result.error = 'LISK_RPC_URL is not set';
  else if (!config.lisk.usdcContractAddress) result.error = 'LISK_USDC_CONTRACT_ADDRESS is not set';
  if (!result.envs) return result;

  try {
    result.rpcHost = new URL(config.lisk.rpcUrl).host;
  } catch (_) {
    result.error = `LISK_RPC_URL is not a valid URL: "${String(config.lisk.rpcUrl).slice(0, 80)}"`;
    return result;
  }

  // A genuine RPC round-trip (eth_chainId). Unlike ethers' getNetwork(), which
  // the staticNetwork pin short-circuits without touching the network, this
  // actually exercises connectivity and surfaces a non-JSON body verbatim.
  try {
    const chainIdHex = await withRetry(() => rawRpcProbe('eth_chainId'));
    result.rpc = `chainId ${Number(chainIdHex)}`;
  } catch (error) {
    result.error = `RPC unreachable: ${error.message}`;
    return result;
  }

  try {
    const code = await withRetry(() => rawRpcProbe('eth_getCode', [config.lisk.usdcContractAddress, 'latest']));
    if (!code || code === '0x') {
      result.error = `no contract code at ${config.lisk.usdcContractAddress} on this chain`;
      return result;
    }
    result.contract = 'ok';
  } catch (error) {
    result.error = `contract check failed: ${error.message}`;
    return result;
  }

  try {
    // Probe with a throwaway address — this only exercises the read path.
    await getBalance({ address: '0x0000000000000000000000000000000000000001' });
    result.balanceRead = 'ok';
    result.ok = true;
  } catch (error) {
    result.error = `balance read failed: ${error.shortMessage || error.message}`;
  }
  return result;
};

// Native balance, in wei — used by the payment orchestrator to decide whether
// the sending wallet needs a gas top-up before a token transfer.
//
// The gas token here is ETH, not LSK. Lisk is an OP Stack L2, so it inherits
// L1's native currency: the WETH9 predeploy at 0x42..06 reports "Wrapped
// Ether", and LSK itself exists on the chain as ordinary ERC-20 contracts.
// This was previously labelled LSK throughout, which showed users an ETH
// balance under an LSK ticker and sent anyone topping up a gas wallet after
// the wrong asset.
const getNativeBalance = async ({ address }) => {
  const raw = await provider().getBalance(address);
  return { value: ethers.formatEther(raw), raw: raw.toString() };
};

// Everything that must hold for a token transfer to succeed, checked before
// submitting one. Without this the only signal is a post-hoc revert string:
// "ERC20: transfer amount exceeds balance" (no USDC) and "insufficient funds
// for intrinsic transaction cost" (no ETH for gas) are completely different
// problems for the user, and both used to surface as one vague "not enough
// money" message. Checking up front also avoids recording a failed
// transaction row for something we could see coming.
//
// Returns { ok: true } or { ok: false, reason, have, need, symbol }.
const preflightTransfer = async ({ fromAddress, destination, amount, tokenAddress = config.lisk.usdcContractAddress }) => {
  if (!tokenAddress) throw new Error('Token contract address is required for a Lisk token transfer.');

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider());
  const [decimals, tokenRaw, nativeRaw, feeData] = await withRetry(() =>
    Promise.all([
      token.decimals(),
      token.balanceOf(fromAddress),
      provider().getBalance(fromAddress),
      provider().getFeeData(),
    ])
  );

  const needed = ethers.parseUnits(String(amount), decimals);
  if (tokenRaw < needed) {
    return {
      ok: false,
      reason: 'insufficient_token',
      have: ethers.formatUnits(tokenRaw, decimals),
      need: String(amount),
      symbol: 'USDC',
    };
  }

  // estimateGas covers L2 execution only; OP Stack also charges an L1 data
  // fee. Both are tiny (~1e-7 ETH combined at current prices), so rather than
  // query the L1 oracle we apply a generous multiplier — being wrong here in
  // the cautious direction costs the user nothing.
  let gasUnits = 100_000n;
  try {
    gasUnits = await token.transfer.estimateGas(destination, needed, { from: fromAddress });
  } catch (_) {
    // Estimation can revert for reasons we've already ruled out above; fall
    // back to a safe ceiling rather than blocking the send on it.
  }
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  const gasCost = gasUnits * gasPrice * 3n;

  if (nativeRaw < gasCost) {
    return {
      ok: false,
      reason: 'insufficient_gas',
      have: ethers.formatEther(nativeRaw),
      need: ethers.formatEther(gasCost),
      symbol: 'ETH',
    };
  }

  return { ok: true };
};

// GETs JSON from the Blockscout explorer, guarding against a non-JSON body the
// same way rawRpcProbe does (a misconfigured LISK_EXPLORER_BASE_URL, or a
// rate-limit/proxy page, would otherwise blow up with an opaque parse error).
const explorerGet = async (path) => {
  if (!config.lisk.explorerBaseUrl) {
    throw new Error('Lisk explorer is not configured. Set LISK_EXPLORER_BASE_URL.');
  }
  const url = `${config.lisk.explorerBaseUrl.replace(/\/+$/, '')}${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`explorer returned HTTP ${response.status} non-JSON body: "${snippet}"`);
  }
};

// True when an amount is large enough to show at the 6-dp display precision —
// filters out dust (e.g. 1000 wei of an 18-decimal LP token = 1e-15) that would
// otherwise render as a meaningless "0 TOKEN" line.
const hasVisibleAmount = (amount) => Number(Number(amount).toFixed(6)) !== 0;

// Every token the wallet holds, via the Blockscout v2 API — used by the "balance"
// command so users see all their holdings, not just USDC. Returns the native
// coin first, then non-zero ERC-20s sorted by USD value, capped at `limit`. Each
// entry carries `usdPrice` (from the explorer's exchange_rate) when known, so the
// caller can render a naira figure. Throws on explorer failure so the caller can
// fall back to the single-USDC on-chain read rather than show nothing.
const getTokenBalances = async ({ address, limit = 10 }) => {
  const [tokenRows, account] = await withRetry(() =>
    Promise.all([
      explorerGet(`/api/v2/addresses/${address}/token-balances`),
      explorerGet(`/api/v2/addresses/${address}`),
    ])
  );

  const tokens = (Array.isArray(tokenRows) ? tokenRows : [])
    .filter((row) => row?.token?.type === 'ERC-20')
    .filter((row) => row?.token?.reputation !== 'scam' && !row?.token?.is_scam)
    .filter((row) => row?.value && row.value !== '0')
    .map((row) => {
      const decimals = Number(row.token.decimals) || 18;
      const usdPrice = Number(row.token.exchange_rate) || null;
      const amount = ethers.formatUnits(row.value, decimals);
      return {
        symbol: row.token.symbol || 'TOKEN',
        name: row.token.name || row.token.symbol || 'Token',
        address: row.token.address_hash || row.token.address,
        decimals,
        amount,
        raw: String(row.value),
        usdPrice,
        native: false,
      };
    })
    .filter((t) => hasVisibleAmount(t.amount))
    .sort((a, b) => Number(b.amount) * (b.usdPrice || 0) - Number(a.amount) * (a.usdPrice || 0))
    .slice(0, limit);

  const nativeRaw = account?.coin_balance;
  const balances = [];
  if (nativeRaw && nativeRaw !== '0' && hasVisibleAmount(ethers.formatEther(nativeRaw))) {
    balances.push({
      // coin_balance is the chain's native currency, which on an OP Stack L2
      // is ETH — not LSK. LSK trades on Lisk as an ordinary ERC-20 and so
      // arrives through the token list above, like any other holding.
      symbol: config.lisk.nativeSymbol,
      name: 'Ether',
      address: null,
      decimals: 18,
      amount: ethers.formatEther(nativeRaw),
      raw: String(nativeRaw),
      usdPrice: Number(account.exchange_rate) || null,
      native: true,
    });
  }
  return balances.concat(tokens);
};

module.exports = {
  getBalance,
  getNativeBalance,
  getTokenBalances,
  preflightTransfer,
  // The effective chain id, with LISK_CHAIN_ID's non-numeric default ('lisk')
  // already resolved to the testnet fallback. Exported so callers that gate on
  // which network they're talking to read the same value the RPC calls use,
  // rather than re-deriving it from raw config and disagreeing.
  resolvedChainId,
  checkHealth,
};
