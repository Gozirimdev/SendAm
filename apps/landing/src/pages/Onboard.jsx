import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { API_BASE_URL } from '@/lib/links.js';

// Statuses: 'loading' (checking the token) -> 'ready' (form shown) ->
// 'submitting' -> 'done', or 'invalid' at any point the token turns out to
// be bad/expired/already used.
export default function Onboard() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [status, setStatus] = useState(token ? 'loading' : 'invalid');
  const [name, setName] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState('');
  const [walletAddress, setWalletAddress] = useState('');

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
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!acceptedTerms) {
      setError('Please accept the Terms & Conditions to continue.');
      return;
    }

    setStatus('submitting');
    try {
      const res = await fetch(`${API_BASE_URL}/api/onboarding/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, acceptedTerms }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        setError(body.message || 'Something went wrong. Please try again.');
        setStatus('ready');
        return;
      }
      setWalletAddress(body.data?.walletAddress || '');
      setStatus('done');
    } catch {
      setError('Something went wrong. Please try again.');
      setStatus('ready');
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

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-12">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8"
      >
        <h1 className="text-2xl font-bold text-dark mb-2">Finish setting up SendAm</h1>
        <p className="text-gray-500 mb-6">Confirm your name and accept the terms to activate your wallet.</p>

        <label htmlFor="name" className="block text-sm font-medium text-dark mb-1">
          What should we call you?
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          required
          className="w-full border border-gray-200 rounded-lg px-4 py-2 mb-6 focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="e.g. Ada"
        />

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
          disabled={status === 'submitting'}
          className="w-full bg-primary hover:bg-accent disabled:opacity-60 text-white px-6 py-3 rounded-lg font-medium transition-colors"
        >
          {status === 'submitting' ? 'Setting up…' : 'Activate my wallet'}
        </button>
      </form>
    </div>
  );
}
