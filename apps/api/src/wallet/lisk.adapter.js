const { ethers } = require('ethers');
const config = require('../config/env');
const cryptoService = require('../services/crypto.service');
const prisma = require('../common/prisma');

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
    // That detection call is the first RPC touch in a balance lookup (wallet
    // creation never hits the RPC), and against the public Lisk endpoint it
    // intermittently times out on cold start — surfacing to the user as
    // "Couldn't fetch your balance right now". Pinning removes that hop.
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

// Self-custody: the wallet's private key never leaves this process. It's
// generated here, encrypted at rest via crypto.service (AES-256-GCM), and
// only decrypted in-memory for the lifetime of a single signing call.
const createManagedWallet = async () => {
  const wallet = ethers.Wallet.createRandom();
  return {
    providerWalletId: wallet.address,
    address: wallet.address,
    encryptedSecretKey: cryptoService.encrypt(wallet.privateKey),
  };
};

// `chain` is accepted for interface parity with the other adapters but
// unused: this adapter only ever talks to Lisk.
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

// Native LSK balance, in wei — used by the payment orchestrator to decide
// whether the sending wallet needs a gas top-up before a token transfer.
const getNativeBalance = async ({ address }) => {
  const raw = await provider().getBalance(address);
  return { value: ethers.formatEther(raw), raw: raw.toString() };
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

// Every token the wallet holds, via the Blockscout v2 API — used by the "balance"
// command so users see all their holdings, not just USDC. Returns native LSK
// first, then non-zero ERC-20s sorted by USD value, capped at `limit`. Each entry
// carries `usdPrice` (from the explorer's exchange_rate) when known, so the
// caller can render a naira figure. Throws on explorer failure so the caller can
// fall back to the single-USDC on-chain read rather than show nothing.
// True when an amount is large enough to show at the 6-dp display precision —
// filters out dust (e.g. 1000 wei of an 18-decimal LP token = 1e-15) that would
// otherwise render as a meaningless "0 TOKEN" line.
const hasVisibleAmount = (amount) => Number(Number(amount).toFixed(6)) !== 0;

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
      symbol: 'LSK',
      name: 'Lisk',
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

const signerFor = async (fromAddress) => {
  const wallet = await prisma.wallet.findFirst({ where: { address: fromAddress } });
  if (!wallet || !wallet.encryptedSecretKey) {
    throw new Error(`No self-custodied key found for address ${fromAddress}.`);
  }
  const privateKey = cryptoService.decrypt(wallet.encryptedSecretKey);
  return new ethers.Wallet(privateKey, provider());
};

const sendToken = async ({ fromAddress, destination, amount, tokenAddress = config.lisk.usdcContractAddress }) => {
  if (!tokenAddress) {
    throw new Error('Token contract address is required for a Lisk token transfer.');
  }
  const signer = await signerFor(fromAddress);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const decimals = await token.decimals();
  const tx = await token.transfer(destination, ethers.parseUnits(String(amount), decimals));
  const receipt = await tx.wait();
  return {
    transactionHash: receipt.hash,
    explorerUrl: config.lisk.explorerBaseUrl ? `${config.lisk.explorerBaseUrl}/tx/${receipt.hash}` : undefined,
  };
};

// Moves native LSK from the platform gas wallet to a user wallet that's
// below its gas threshold. `amountWei` comes from a paymaster top-up plan
// (see paymaster.client.js) — paymaster only plans, this executes it.
const sendNative = async ({ fromAddress, destination, amountWei }) => {
  const signer = await signerFor(fromAddress);
  const tx = await signer.sendTransaction({ to: destination, value: BigInt(amountWei) });
  const receipt = await tx.wait();
  return { transactionHash: receipt.hash };
};

module.exports = {
  createManagedWallet,
  getBalance,
  getNativeBalance,
  getTokenBalances,
  sendToken,
  sendNative,
  checkHealth,
};
