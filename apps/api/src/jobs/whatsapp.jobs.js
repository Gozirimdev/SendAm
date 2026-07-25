const { registerProcessor } = require('../queues/queue.service');
const { processMessage } = require('../whatsapp/assistant.service');
const { processVoiceMessage } = require('../voice/voice.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const logger = require('../utils/logger');

const registerWhatsAppJobs = () => {
  registerProcessor('whatsapp-inbound', async (job) => {
    const { from, whatsappName, text, mediaId, messageType, whatsappMessageId } = job.data;
    logger.info(`Processing WhatsApp ${messageType} job from ${from}`);

    try {
      if (messageType === 'audio' || messageType === 'voice') {
        await processVoiceMessage({ phoneNumber: from, whatsappName, mediaId, whatsappMessageId });
        return;
      }

      await processMessage(from, whatsappName, text);
    } catch (error) {
      // Backstop against the failure mode that made the bot look dead: an
      // unhandled throw anywhere in message handling used to unwind the job
      // with no reply ever sent, so the user saw nothing at all.
      //
      // Deliberately swallowed rather than rethrown. Money movement happens
      // inside processMessage, and BullMQ retries a failed job up to three
      // times — rethrowing here would risk replaying a payment that already
      // went through. The error is logged for operators; the user gets a reply.
      logger.error(`Unhandled error processing WhatsApp ${messageType} from ${from}:`, error);
      await sendTextMessage(
        from,
        "Sorry — something went wrong on my side and I couldn't finish that. No money has moved. Please try again in a moment."
      );
    }
  });

  logger.info('WhatsApp queue processor registered');
};

module.exports = {
  registerWhatsAppJobs,
};
