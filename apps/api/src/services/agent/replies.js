// Shared user-facing WhatsApp copy.
//
// This module once held a whole fixed command vocabulary. None of it was
// reachable any more — the live conversational copy is in
// whatsapp/assistant.service.js, and only the rate-limit line was still being
// called — so the unreachable set was removed rather than left to look like
// current behaviour.

const replies = {
  rateLimited: () => `You're sending messages too quickly. Please wait a moment and try again.`,
};

module.exports = {
  replies,
};
