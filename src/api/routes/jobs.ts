import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { getConfig, repoAllowed } from '../../config.js';
import { t } from '../../i18n/index.js';
import { newJobId } from '../../util/ids.js';
import * as store from '../../jobs/store.js';
import * as queue from '../../jobs/queue.js';
import { emit } from '../../notify/bus.js';
import { requireApiKey } from '../auth.js';
import type { JobRequest, Job, JobStatus } from '../../types.js';

const cfg = getConfig();

const jobRequestSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must look like owner/name'),
  base: z.string().default(cfg.DEFAULT_BASE_BRANCH),
  branch: z.string().nullable().default(null),
  instruction: z.string().min(3),
  context: z.record(z.string()).default({}),
  verify: z.array(z.string()).default([]),
  pr: z
    .object({
      draft: z.boolean().default(true),
      labels: z.array(z.string()).default([]),
      reviewers: z.array(z.string()).default([]),
      title: z.string().optional(),
    })
    .default({ draft: true, labels: [], reviewers: [] }),
  notify: z
    .object({
      kind: z.enum(['flow', 'webhook', 'none']).default('flow'),
      postId: z.string().nullable().default(null),
      url: z.string().nullable().default(null),
    })
    .default({ kind: 'flow', postId: null, url: null }),
  locale: z.enum(['ko', 'en']).default(cfg.LOCALE),
  dryRun: z.boolean().default(false),
  idempotencyKey: z.string().nullable().default(null),
});

export class RepoNotAllowed extends Error {}

/**
 * The single door every inbound path walks through — the SigNoz adapter calls
 * this exactly like a hand-written POST does, so both share one set of checks.
 */
export function acceptJob(request: JobRequest): { job: Job; deduplicated: boolean } {
  if (!repoAllowed(request.repo, cfg.ALLOWED_REPOS)) {
    throw new RepoNotAllowed(t(request.locale, 'error.repo_not_allowed', { repo: request.repo }));
  }

  if (request.idempotencyKey) {
    const existing = store.getJobByIdempotencyKey(request.idempotencyKey);
    if (existing) return { job: existing, deduplicated: true };
  }

  const job = store.createJob(newJobId(), request);
  const waiting = queue.willWait(job.repo);
  void emit(job, {
    stage: 'queued',
    status: 'started',
    key: waiting ? 'job.accepted.waiting' : 'job.accepted',
    params: { repo: job.repo },
    data: { idempotencyKey: job.idempotencyKey },
  });
  queue.enqueue(job);
  return { job, deduplicated: false };
}

export default async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireApiKey);

  app.post('/v1/jobs', async (req, reply) => {
    const parsed = jobRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: t(cfg.LOCALE, 'error.invalid_payload', {
          detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        }),
      });
    }

    const headerKey = req.headers['idempotency-key'];
    const request: JobRequest = {
      ...parsed.data,
      idempotencyKey:
        parsed.data.idempotencyKey ?? (typeof headerKey === 'string' ? headerKey : null),
    };

    try {
      const { job, deduplicated } = acceptJob(request);
      return reply.code(deduplicated ? 200 : 202).send({
        jobId: job.id,
        status: job.status,
        deduplicated,
        streamUrl: `/v1/jobs/${job.id}/events`,
      });
    } catch (err) {
      if (err instanceof RepoNotAllowed) return reply.code(403).send({ error: err.message });
      throw err;
    }
  });

  app.get('/v1/jobs', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const jobs = store.listJobs({
      status: q.status as JobStatus | undefined,
      repo: q.repo,
      limit: q.limit ? Math.min(Number(q.limit), 200) : 50,
    });
    return reply.send({ jobs, stats: store.statsToday() });
  });

  app.get('/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.getJob(id);
    if (!job) return reply.code(404).send({ error: t(cfg.LOCALE, 'error.job_not_found') });
    return reply.send({ ...job, running: queue.isRunning(id) });
  });

  app.get('/v1/jobs/:id/log', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.getJob(id);
    if (!job) return reply.code(404).send({ error: t(cfg.LOCALE, 'error.job_not_found') });
    return reply.send({
      job,
      events: store.listEvents(id),
      failedDeliveries: store.failedDeliveries(id),
    });
  });

  app.post('/v1/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.getJob(id);
    if (!job) return reply.code(404).send({ error: t(cfg.LOCALE, 'error.job_not_found') });
    const cancelled = queue.cancel(id);
    return reply.send({ jobId: id, cancelled });
  });
}
