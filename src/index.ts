import http from 'http';
import { createApp } from './app';
import { config } from './utils/config';
import { logger } from './utils/logger';
import { initGithubApp } from './services/github';
import { startWorker, closeQueue, isQueueEnabled } from './services/queue';

let server: http.Server | undefined;

async function main(): Promise<void> {
  await initGithubApp(); // ESM module — must load before webhook handlers register

  const app = createApp();
  startWorker();

  const models = config.llm.provider === 'openai'
    ? `${config.openai.model} (judge: ${config.openai.judgeModel})`
    : `${config.anthropic.model} (judge: ${config.anthropic.judgeModel})`;

  server = app.listen(config.server.port, () => {
    logger.info(`ai-auto-merge listening on port ${config.server.port} [${config.server.nodeEnv}]`);
    logger.info(`LLM: ${config.llm.provider} — ${models}`);
    logger.info(`Queue: ${isQueueEnabled() ? `BullMQ (${process.env.REDIS_URL})` : 'disabled — in-process fallback active'}`);
    logger.info('Webhook endpoint: POST /webhook');
    logger.info('Health check:     GET  /health');
    logger.info('Dashboard:        GET  /dashboard');
    logger.info('Metrics:          GET  /metrics');
    if (!config.server.dashboardToken && config.server.nodeEnv === 'production') {
      logger.warn('DASHBOARD_TOKEN is not set — /dashboard, /api/* and /metrics are publicly readable');
    }
  });
}

const SHUTDOWN_GRACE_MS = 10_000;

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully`);

  // In-flight resolutions can take a while; don't hang forever on a stuck socket.
  const forceExit = setTimeout(() => {
    logger.warn(`Forcing exit after ${SHUTDOWN_GRACE_MS}ms grace period`);
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  if (!server) {
    await closeQueue();
    process.exit(0);
  }

  server.close(async () => {
    await closeQueue();
    logger.info('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception, exiting:', err);
  process.exit(1);
});

main().catch((err) => {
  logger.error('Fatal: failed to start ai-auto-merge:', err);
  process.exit(1);
});
