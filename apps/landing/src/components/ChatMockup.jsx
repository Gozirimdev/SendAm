import { Check, CheckCheck } from 'lucide-react';

// A stylised WhatsApp conversation showing the real SendAm command flow.
// This is the product demo: it shows, rather than tells, how a transfer works.
const messages = [
  { from: 'user', text: 'create wallet', time: '9:41' },
  {
    from: 'bot',
    text: '✅ Your chain wallet is ready!\nGABC…7XQ2 — funded on testnet.',
    time: '9:41',
  },
  { from: 'user', text: 'send 5 token ada', time: '9:42' },
  {
    from: 'bot',
    text: 'Send 5 TOKEN to ada (GABC…7XQ2)?\nReply YES to confirm or NO to cancel.',
    time: '9:42',
  },
  { from: 'user', text: 'yes', time: '9:42' },
  {
    from: 'bot',
    text: '🎉 Sent 5 TOKEN to ada.\nReceipt: chain.expert/tx/…',
    time: '9:42',
  },
];

export default function ChatMockup() {
  return (
    <div className="relative mx-auto w-full max-w-sm">
      {/* Phone frame */}
      <div className="rounded-[2.5rem] border-[10px] border-slate-900 bg-slate-900 shadow-2xl shadow-slate-900/20">
        <div className="overflow-hidden rounded-[1.75rem] bg-[#ece5dd]">
          {/* Chat header */}
          <div className="flex items-center gap-3 bg-whatsapp-dark px-4 py-3 text-white">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 font-bold">
              S
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold">SendAm</p>
              <p className="text-[11px] text-white/70">online</p>
            </div>
          </div>

          {/* Messages */}
          <div className="space-y-2 px-3 py-4">
            {messages.map((m, i) => {
              const isUser = m.from === 'user';
              return (
                <div
                  key={i}
                  className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] whitespace-pre-line rounded-2xl px-3 py-2 text-[13px] leading-snug shadow-sm ${
                      isUser
                        ? 'rounded-br-sm bg-[#d9fdd3] text-slate-800'
                        : 'rounded-bl-sm bg-white text-slate-800'
                    }`}
                  >
                    {m.text}
                    <span className="ml-2 inline-flex items-center gap-0.5 align-bottom text-[10px] text-slate-400">
                      {m.time}
                      {isUser && <CheckCheck size={12} className="text-sky-500" />}
                      {!isUser && <Check size={12} />}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Input bar (decorative) */}
          <div className="flex items-center gap-2 px-3 pb-4">
            <div className="flex-1 rounded-full bg-white px-4 py-2 text-[13px] text-slate-400">
              Type a message
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-whatsapp text-white">
              <Check size={16} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
