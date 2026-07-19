const { registerWhatsAppJobs } = require('./whatsapp.jobs');
const { registerSendamAiKeepAlive } = require('./sendamAiKeepAlive.job');

const registerJobs = () => {
  registerWhatsAppJobs();
  registerSendamAiKeepAlive();
};

module.exports = {
  registerJobs,
};
