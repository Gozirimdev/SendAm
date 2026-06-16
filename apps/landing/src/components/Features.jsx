import { Wallet, MessageSquare, Sendrpctal, Users } from 'lucide-react';

const features = [
  {
    title: 'Create a wallet',
    desc: 'Generate a secure chain wallet in seconds — just text “create wallet”.',
    icon: Wallet,
  },
  {
    title: 'Check your balance',
    desc: 'Send “balance” any time to see your live TOKEN balance from the chain network.',
    icon: MessageSquare,
  },
  {
    title: 'Send TOKEN anywhere',
    desc: 'Move value across borders in seconds with a simple “send 5 token …” message.',
    icon: Sendrpctal,
  },
  {
    title: 'Save contacts',
    desc: 'Store recipients by name once, then pay them by alias instead of long keys.',
    icon: Users,
  },
];

export default function Features() {
  return (
    <section id="features" className="container mx-auto px-4 py-16 sm:px-6 lg:py-24">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-dark sm:text-4xl">
          Everything you need, in a chat
        </h2>
        <p className="mt-4 text-slate-600">
          No dashboards to learn. Each action is a single WhatsApp message.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f) => {
          const Icon = f.icon;
          return (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm transition-shadow hover:shadow-md sm:p-7"
            >
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-secondary text-primary">
                <Icon size={26} aria-hidden="true" />
              </div>
              <h3 className="mb-2 text-lg font-bold text-dark">{f.title}</h3>
              <p className="text-sm leading-relaxed text-slate-600">{f.desc}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
