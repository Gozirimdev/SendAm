// Retry wrapper for the one-shot funding scripts.
//
// The public Lisk RPC intermittently drops a request that succeeds immediately
// on a second attempt — curl and a bare fetch against the same endpoint stay
// consistently sub-second, so this is not the endpoint being down. ethers
// surfaces it as a bare "request timeout", which in a setup script reads as
// "this tool is broken" and stops someone in their tracks.
//
// src/chain/lisk.reader.js already does this for the server's own calls; the
// scripts build their own providers and so had none of it.
//
// Only wraps reads and pre-flight checks. Never wrap a transaction submission:
// a "timeout" there may mean the transaction was broadcast and the response
// lost, and retrying would send it twice.

const TRANSIENT = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network error|SERVER_ERROR/i;

const isTransient = (error) =>
  TRANSIENT.test(String(error?.message || '')) || TRANSIENT.test(String(error?.code || ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn`, retrying only transient network failures.
 *
 * @param {Function} fn
 * @param {{attempts?: number, label?: string, onRetry?: Function}} options
 */
const withRetry = async (fn, { attempts = 3, label = 'request', onRetry } = {}) => {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // A real error — wrong address, insufficient funds, reverted call — must
      // surface immediately rather than be retried into a confusing delay.
      if (!isTransient(error) || i === attempts) throw error;
      if (onRetry) onRetry(i, attempts, error);
      else console.log(`  ${label} failed (${error.shortMessage || error.message}) — retrying ${i}/${attempts - 1}...`);
      await sleep(1000 * i);
    }
  }
  throw lastError;
};

module.exports = { withRetry, isTransient };
