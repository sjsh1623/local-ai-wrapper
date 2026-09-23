import type { FastifyInstance } from 'fastify';
import { logger } from '../../logger.js';
import { requireSignozBasic } from '../auth.js';
import { decideAll, signozPayloadSchema } from '../../inbound/signoz.js';
import { acceptJob, RepoNotAllowed } from './jobs.js';
import * as store from '../../jobs/store.js';
import * as queue from '../../jobs/queue.js';

export default async function hookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/hooks/signoz', { preHandler: requireSignozBasic }, async (req, reply) => {
    // The whole body, once, before anything can decide to drop it. Which alerts
    // became jobs is easy to reconstruct afterwards from the job records; what
    // SigNoz actually put on the wire is not, unless it was written down here.
    logger.info({ webhook: req.body }, 'SigNoz webhook received');

    const parsed = signozPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // Still a 200: a 4xx makes SigNoz redeliver the whole batch on a loop.
      logger.warn({ issues: parsed.error.issues, body: req.body }, 'unrecognised SigNoz payload');
      return reply.code(200).send({ accepted: 0, skipped: 0, error: 'unrecognised payload' });
    }

    const results: Array<Record<string, unknown>> = [];
    let accepted = 0;
    let skipped = 0;

    for (const decision of decideAll(parsed.data)) {
      if (decision.action === 'skip') {
        skipped++;
        logger.debug({ reason: decision.reason, fingerprint: decision.fingerprint }, 'alert skipped');
        results.push({ fingerprint: decision.fingerprint, action: 'skip', reason: decision.reason });
        continue;
      }

      if (decision.action === 'cancel') {
        const existing = store.getJobByIdempotencyKey(`signoz:${decision.fingerprint}`);
        const cancelled = existing ? queue.cancel(existing.id) : false;
        results.push({ fingerprint: decision.fingerprint, action: 'cancel', cancelled });
        continue;
      }

      try {
        const { job, deduplicated } = acceptJob(decision.request);
        if (!deduplicated) accepted++;
        results.push({
          fingerprint: decision.fingerprint,
          action: deduplicated ? 'deduplicated' : 'accepted',
          jobId: job.id,
        });
      } catch (err) {
        // One bad alert must not sink the batch — record it and keep going.
        const reason = err instanceof RepoNotAllowed ? err.message : String(err);
        logger.warn({ fingerprint: decision.fingerprint, reason }, 'alert rejected');
        results.push({ fingerprint: decision.fingerprint, action: 'rejected', reason });
      }
    }

    return reply.code(200).send({ accepted, skipped, results });
  });
}
