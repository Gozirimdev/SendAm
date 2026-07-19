const sendamAi = require('../sendamAi/sendamAi.client');
const logger = require('../utils/logger');

// Render's free tier spins the sendam-ai deploy down after ~15 min idle, and
// the next real request then eats a cold-start penalty against the
// user-facing WhatsApp reply path. Pinging well inside that idle window
// keeps the instance warm so decode() calls land on an already-running
// instance instead.
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

const registerSendamAiKeepAlive = () => {
  if (!sendamAi.configured()) {
    logger.warn('sendam-ai is not configured; skipping keep-alive ping.');
    return;
  }
  sendamAi.warmup();
  // unref() so this timer alone can't keep the process alive past a
  // graceful shutdown (see server.js's drain-then-exit handler).
  setInterval(() => {
    sendamAi.warmup();
  }, KEEP_ALIVE_INTERVAL_MS).unref();
};

module.exports = { registerSendamAiKeepAlive };
