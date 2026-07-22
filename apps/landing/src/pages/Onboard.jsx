import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { API_BASE_URL } from '@/lib/links.js';

const postJson = (path, body) =>
  fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Statuses: 'loading' (checking the token) -> 'setup' (name/terms/PIN/passkey
// form) -> 'settingUp' -> 'readyToCreate' (the "Create Wallet" button) ->
// 'creating' -> 'done', or 'invalid' at any point the token turns out to be
// bad/expired/already used. The registration token stays alive from 'setup'
// through 'readyToCreate' — it's only burned once wallet creation succeeds.
export default function Onboard() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [status, setStatus] = useState(token ? 'loading' : 'invalid');
  const [name, setName] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [pin, setPin] = useState('');
  const [enablePasskey, setEnablePasskey] = useState(false);
  const [passkeyRegistered, setPasskeyRegistered] = useState(false);
  const [error, setError] = useState('');
  const [passkeyError, setPasskeyError] = useState('');
  const [walletAddress, setWalletAddress] = useState('');

  const passkeySupported = typeof window !== 'undefined' && browserSupportsWebAuthn();

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    fetch(`${API_BASE_URL}/api/onboarding/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !body.success) {
          setStatus('invalid');
          return;
        }
        setName(body.data?.name || '');
        setStatus('setup');
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  // Runs the WebAuthn registration ceremony against the two onboarding
  // endpoints. Never blocks progress to readyToCreate on failure — a passkey
  // is optional, so a cancelled prompt or unsupported browser just leaves
  // passkeyRegistered false and shows an inline, dismissable error.
  const registerPasskey = async () => {
    try {
      const optionsRes = await fetch(`${API_BASE_URL}/api/onboarding/${encodeURIComponent(token)}/webauthn/register-options`);
      const optionsBody = await optionsRes.json().catch(() => ({}));
      if (!optionsRes.ok || !optionsBody.success) {
        throw new Error(optionsBody.message || 'Could not start passkey setup.');
      }

      const attestation = await startRegistration({ optionsJSON: optionsBody.data });

      const verifyRes = await postJson(`/api/onboarding/${encodeURIComponent(token)}/webauthn/register`, attestation);
      const verifyBody = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !verifyBody.success) {
        throw new Error(verifyBody.message || 'Passkey registration failed.');
      }

      setPasskeyRegistered(true);
    } catch (err) {
      setPasskeyError(err.message || 'Passkey setup was cancelled or failed — you can still finish without one.');
    }
  };

  const handleSetupSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setPasskeyError('');

    if (!acceptedTerms) {
      setError('Please accept the Terms & Conditions to continue.');
      return;
    }
    if (!/^\d{4,6}$/.test(pin)) {
      setError('Please enter a 4-6 digit PIN.');
      return;
    }

    setStatus('settingUp');
    try {
      const res = await postJson(`/api/onboarding/${encodeURIComponent(token)}`, { name, acceptedTerms, pin });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        setError(body.message || 'Something went wrong. Please try again.');
        setStatus('setup');
        return;
      }

      if (enablePasskey && passkeySupported) {
        await registerPasskey();
      }

      setStatus('readyToCreate');
    } catch {
      setError('Something went wrong. Please try again.');
      setStatus('setup');
    }
  };

  const handleCreateWallet = async () => {
    setError('');
    setStatus('creating');
    try {
      const res = await postJson(`/api/onboarding/${encodeURIComponent(token)}/wallet`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        setError(body.message || 'Something went wrong. Please try again.');
        setStatus('readyToCreate');
        return;
      }
      setWalletAddress(body.data?.walletAddress || '');
      setStatus('done');
    } catch {
      setError('Something went wrong. Please try again.');
      setStatus('readyToCreate');
    }
  };

  if (status === 'loading') {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-4">
        <p className="text-gray-500">Checking your link…</p>
      </div>
    );
  }

  if (status === 'invalid') {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-4">
        <h2 className="text-3xl font-bold text-dark mb-4">This link is invalid or has expired</h2>
        <p className="text-gray-500 mb-8 max-w-md">
          Go back to WhatsApp and say "yes" the next time SendAm asks if you want to get started — that sends a fresh link.
        </p>
        <Link to="/" className="bg-primary hover:bg-accent text-white px-6 py-3 rounded-lg font-medium transition-colors">
          Return Home
        </Link>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-4">
        <h2 className="text-3xl font-bold text-dark mb-4">You're all set 🎉</h2>
        <p className="text-gray-500 mb-2 max-w-md">
          Your SendAm wallet is ready. Head back to WhatsApp to send or receive money.
        </p>
        {walletAddress && (
          <p className="text-sm text-gray-400 mb-8 break-all max-w-md">Wallet: {walletAddress}</p>
        )}
      </div>
    );
  }

  if (status === 'readyToCreate' || status === 'creating') {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
          <h1 className="text-2xl font-bold text-dark mb-2">Ready to create your wallet</h1>
          <p className="text-gray-500 mb-1">PIN set{passkeyRegistered ? ' · Passkey enabled' : ''}.</p>
          <p className="text-gray-500 mb-6">Click below to activate your SendAm wallet on Lisk.</p>

          {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

          <button
            type="button"
            onClick={handleCreateWallet}
            disabled={status === 'creating'}
            className="w-full bg-primary hover:bg-accent disabled:opacity-60 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            {status === 'creating' ? 'Creating your wallet…' : 'Create Wallet'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-12">
      <form
        onSubmit={handleSetupSubmit}
        className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8"
      >
        <h1 className="text-2xl font-bold text-dark mb-2">Finish setting up SendAm</h1>
        <p className="text-gray-500 mb-6">Set a PIN and accept the terms — we already have your number and name from WhatsApp.</p>

        <label htmlFor="name" className="block text-sm font-medium text-dark mb-1">
          Display name
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          className="w-full border border-gray-200 rounded-lg px-4 py-2 mb-1 focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="e.g. Ada"
        />
        <p className="text-xs text-gray-400 mb-6">This is what you told us on WhatsApp — change it here if you'd like.</p>

        <label htmlFor="pin" className="block text-sm font-medium text-dark mb-1">
          Transaction PIN
        </label>
        <input
          id="pin"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          maxLength={6}
          className="w-full border border-gray-200 rounded-lg px-4 py-2 mb-1 focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="4-6 digits"
        />
        <p className="text-xs text-gray-400 mb-6">You'll use this PIN to confirm sends over WhatsApp.</p>

        {passkeySupported && (
          <label className="flex items-start gap-2 mb-6 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={enablePasskey}
              onChange={(e) => setEnablePasskey(e.target.checked)}
              className="mt-1"
            />
            <span>
              Enable a passkey (Face ID, Touch ID, or Windows Hello) so you can confirm sends without typing your PIN. Optional.
            </span>
          </label>
        )}
        {passkeyError && <p className="text-amber-600 text-xs mb-4">{passkeyError}</p>}

        <div className="border border-gray-200 rounded-lg p-4 mb-4 max-h-40 overflow-y-auto text-sm text-gray-500">
          <p className="font-medium text-dark mb-2">Terms &amp; Conditions (placeholder)</p>
          <p>
            By activating a SendAm wallet you agree to use the service lawfully, that transactions on public
            blockchains are irreversible, and that SendAm is not liable for funds sent to an incorrect
            recipient. Replace this placeholder with real legal copy before launch.
          </p>
        </div>

        <label className="flex items-start gap-2 mb-6 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => setAcceptedTerms(e.target.checked)}
            className="mt-1"
          />
          I have read and accept the Terms &amp; Conditions.
        </label>

        {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

        <button
          type="submit"
          disabled={status === 'settingUp'}
          className="w-full bg-primary hover:bg-accent disabled:opacity-60 text-white px-6 py-3 rounded-lg font-medium transition-colors"
        >
          {status === 'settingUp' ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
