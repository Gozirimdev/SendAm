import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

const faqs = [
  {
    q: 'Do I need a crypto app or wallet to start?',
    a: 'No. SendAm works entirely inside WhatsApp. We create and manage a chain wallet for you — there are no apps to install and no seed phrases to write down.',
  },
  {
    q: 'Is my money safe?',
    a: 'Every wallet reference is encrypted before it is stored, and every transfer asks you to reply YES before any funds move. SendAm is currently a testnet MVP, so it uses test TOKEN rather than real money.',
  },
  {
    q: 'What is TOKEN?',
    a: 'TOKEN (Lumens) is the native asset of the chain network — a fast, low-cost blockchain built for payments. SendAm uses it to settle transfers in seconds.',
  },
  {
    q: 'Is this real money?',
    a: 'Not yet. SendAm runs on the chain Testnet, so balances and transfers use test funds. This lets you try the full experience risk-free while the product matures toward a real-money launch.',
  },
];

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-100">
      <h3>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-4 py-5 text-left text-base font-semibold text-dark transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {q}
          <ChevronDown
            size={20}
            aria-hidden="true"
            className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </h3>
      {open && (
        <p className="pb-5 text-sm leading-relaxed text-slate-600">{a}</p>
      )}
    </div>
  );
}

export default function Faq() {
  return (
    <section id="faq" className="container mx-auto px-4 py-16 sm:px-6 lg:py-24">
      <div className="mx-auto max-w-3xl">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-dark sm:text-4xl">
            Frequently asked questions
          </h2>
        </div>
        <div>
          {faqs.map((f) => (
            <FaqItem key={f.q} {...f} />
          ))}
        </div>
      </div>
    </section>
  );
}
