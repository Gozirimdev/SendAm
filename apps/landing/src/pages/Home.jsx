import { MessageSquare, Wallet, Sendrpctal, Zap } from 'lucide-react';

const ADMIN_URL = import.meta.env.VITE_ADMIN_URL || 'http://localhost:3001';

export default function Home() {
  const features = [
    { title: 'Create Wallet', desc: 'Instantly generate a secure chain wallet via WhatsApp.', icon: Wallet },
    { title: 'Check Balance', desc: 'Query your TOKEN balance anytime with a simple text message.', icon: MessageSquare },
    { title: 'Send TOKEN', desc: 'Transfer funds across the globe in seconds.', icon: Sendrpctal },
    { title: 'Lightning Fast', desc: 'Powered by the chain network for near-instant settlement.', icon: Zap },
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center py-12 sm:py-16 lg:py-20 px-4 sm:px-6">
      <div className="text-center max-w-3xl mx-auto mb-10 sm:mb-14 lg:mb-16">
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-dark tracking-tight mb-5 sm:mb-6 leading-tight">
          Crypto Payments via <span className="text-primary">WhatsApp</span>
        </h1>
        <p className="text-base sm:text-lg lg:text-xl text-gray-500 mb-8 sm:mb-10 max-w-2xl mx-auto">
          SendAm connects the power of the chain network with the simplicity of WhatsApp. Create wallets and send TOKEN effortlessly.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <a href={ADMIN_URL} className="w-full sm:w-auto bg-primary hover:bg-accent text-white px-8 py-4 rounded-xl font-semibold shadow-lg shadow-teal-500/30 transition-all hover:-translate-y-0.5">
            Admin Dashboard
          </a>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 max-w-6xl mx-auto w-full">
        {features.map((f, i) => {
          const Icon = f.icon;
          return (
            <div key={i} className="bg-white p-6 sm:p-8 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
              <div className="bg-secondary w-14 h-14 rounded-xl flex items-center justify-center mb-6 text-primary">
                <Icon size={28} />
              </div>
              <h3 className="text-xl font-bold mb-3">{f.title}</h3>
              <p className="text-gray-500 leading-relaxed">{f.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
