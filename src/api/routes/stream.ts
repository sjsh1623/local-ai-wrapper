import type { FastifyInstance } from 'fastify';
import { getConfig } from '../../config.js';
import { t } from '../../i18n/index.js';
import * as store from '../../jobs/store.js';
import { requireApiKey } from '../auth.js';
import { addClient, writeComment, writeEvent } from '../../notify/transports/sse.js';

const cfg = getConfig();

function openStream(reply: any): void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

/** `Last-Event-ID` looks like `job_XXX:12`; we only need the sequence. */
function seqFromLastEventId(header: unknown): number {
  if (typeof header !== 'string') return 0;
  const seq = Number(header.split(':').pop());
  return Number.isFinite(seq) ? seq : 0;
}

export default async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireApiKey);

  // Everything, for the console.
  app.get('/v1/stream', async (req, reply) => {
    openStream(reply);
    for (const event of store.recentEvents(200)) writeEvent(reply, event);
    addClient(reply, null);

    const beat = setInterval(() => writeComment(reply, 'keepalive'), 25_000);
    reply.raw.on('close', () => clearInterval(beat));
    return reply;
  });

  // One job, resumable from the last sequence the client saw.
  app.get('/v1/jobs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.getJob(id);
    if (!job) return reply.code(404).send({ error: t(cfg.LOCALE, 'error.job_not_found') });

    const after = seqFromLastEventId(req.headers['last-event-id']);
    openStream(reply);
    for (const event of store.listEvents(id, after)) writeEvent(reply, event);
    addClient(reply, id);

    const beat = setInterval(() => writeComment(reply, 'keepalive'), 25_000);
    reply.raw.on('close', () => clearInterval(beat));
    return reply;
  });
}
