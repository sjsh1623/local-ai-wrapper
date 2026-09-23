import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import { loadRoutes } from './inbound/routes.js';
import * as store from './jobs/store.js';
import * as queue from './jobs/queue.js';
import jobRoutes from './api/routes/jobs.js';
import hookRoutes from './api/routes/hooks.js';
import streamRoutes from './api/routes/stream.js';
import healthRoutes from './api/routes/health.js';
import consoleRoutes from './api/routes/console.js';
import { authDisabled } from './api/auth.js';
import { activeProvider } from './agent/index.js';

const cfg = getConfig();

const app = Fastify({
  loggerInstance: logger,
  bodyLimit: 4 * 1024 * 1024,
  trustProxy: false,
});

await app.register(cookie);

// The console posts a plain HTML form; everything else speaks JSON.
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

await app.register(healthRoutes);
await app.register(consoleRoutes);
await app.register(hookRoutes);
// Key-guarded routes are registered in their own scopes so the preHandler
// hook they add cannot leak onto the console or the SigNoz hook.
await app.register(async (scope) => { await scope.register(jobRoutes); });
await app.register(async (scope) => { await scope.register(streamRoutes); });

if (authDisabled) {
  logger.warn(
    'API_KEYS is empty — console login and the /v1 key check are OFF (internal mode). ' +
      'The SigNoz hook still requires Basic Auth.',
  );
}

loadRoutes();

const interrupted = store.reconcileOnBoot();
if (interrupted > 0) {
  logger.warn({ count: interrupted }, 'jobs were left running by a previous shutdown; marked failed');
}
const resumed = queue.resume();
if (resumed > 0) logger.info({ count: resumed }, 'requeued jobs left over from a restart');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await queue.shutdown();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Bound to all interfaces inside the container; docker-compose publishes it on
// 127.0.0.1 only, which is where the exposure decision actually belongs.
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
logger.info(
  {
    port: cfg.PORT,
    locale: cfg.LOCALE,
    concurrency: cfg.JOB_CONCURRENCY,
    agent: activeProvider(),
    model: activeProvider() === 'codex' ? cfg.CODEX_MODEL || '(codex default)' : cfg.CLAUDE_MODEL,
    allowedRepos: cfg.ALLOWED_REPOS,
  },
  'morningmate-alert is listening',
);
