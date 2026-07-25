const app = require('./app');
const config = require('./config/env');
const connectDB = require('./config/db');
const prisma = require('./common/prisma');
const logger = require('./utils/logger');
const { registerJobs } = require('./jobs');
const { logReadiness } = require('./common/featureReadiness');

const startServer = async () => {
  await connectDB();
  registerJobs();
  // Say at boot which features are switched off and why, rather than letting a
  // user discover it by being told something is unavailable.
  logReadiness(logger);

  const server = app.listen(config.port, () => {
    logger.info(`Server running in ${config.env} mode on port ${config.port}`);
  });

  // Graceful shutdown: stop accepting new connections, let in-flight requests
  // finish, close the DB link, then exit. A payment can be mid-submit on
  // deploy/restart, so we drain instead of hard-killing the process.
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully.`);
    server.close(async () => {
      try {
        await prisma.$disconnect();
      } catch (error) {
        logger.error('Error closing PostgreSQL connection:', error.message);
      }
      process.exit(0);
    });

    // Backstop: if draining hangs, force exit rather than block the platform.
    setTimeout(() => {
      logger.error('Could not drain in time — forcing shutdown.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

startServer();
