// Central place for outbound links so the WhatsApp number / admin URL are set
// once (via env) and reused across the nav, hero, and CTAs.

const WHATSAPP_NUMBER = import.meta.env.VITE_WHATSAPP_NUMBER || '';

export const ADMIN_URL = import.meta.env.VITE_ADMIN_URL || 'http://localhost:3001';
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3002';
export const GITHUB_URL = 'https://github.com/Gozirimdev/SendAm';
export const CHAIN_URL = 'https://chain.org';

// Build a wa.me deep link that opens WhatsApp with a prefilled command.
// Without a configured number it falls back to wa.me/ (lets the user pick the
// chat) so the button is never broken in local/dev.
export const whatsappUrl = (message = 'create wallet') => {
  const base = WHATSAPP_NUMBER ? `https://wa.me/${WHATSAPP_NUMBER}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
};
