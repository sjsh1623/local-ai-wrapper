import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../auth.js';
import * as client from '../../qa/client.js';
import * as poller from '../../qa/poller.js';
import * as store from '../../qa/store.js';
import * as triage from '../../qa/triage.js';
import { QA_LANES } from '../../types.js';
import type { QaItem, QaLane } from '../../types.js';

const PROJECT_ID = /^\d{1,15}$/;

export default async function qaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireApiKey);

  // The intake queue as the console shows it. `poller` is always present so a
  // disabled instance can say why its list is empty instead of just being empty.
  app.get('/v1/qa', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const state = q.state === 'open' || q.state === 'gone' ? (q.state as QaItem['state']) : undefined;
    const projectId = q.project && PROJECT_ID.test(q.project) ? q.project : undefined;
    // Caps how many departed items come back; the waiting ones always all do.
    const n = Number(q.limit);
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 100;
    const counts = store.countsByProject();
    return reply.send({
      poller: poller.status(),
      triage: triage.status(),
      projects: store.listProjects().map((p) => ({
        ...p,
        open: counts[p.projectId]?.open ?? 0,
        waiting: counts[p.projectId]?.waiting ?? 0,
        gone: counts[p.projectId]?.gone ?? 0,
      })),
      items: store.list({ state, projectId, limit }),
    });
  });

  // Reads the QA projects again right now. It changes nothing over there; the
  // only thing written is this service's own copy.
  app.post('/v1/qa/poll', async (_req, reply) => {
    const before = poller.status();
    if (!before.enabled) return reply.code(409).send({ poller: before });
    await poller.pollNow();
    return reply.send({ poller: poller.status() });
  });

  // Projects the key's owner takes part in — the picker's choices, with the
  // ones already polled marked so they are not offered twice.
  app.get('/v1/qa/projects/available', async (_req, reply) => {
    const added = new Set(store.listProjects().map((p) => p.projectId));
    try {
      const projects = await client.participatingProjects();
      return reply.send({
        projects: projects.map((p) => ({ ...p, added: added.has(p.projectId) })),
      });
    } catch (err) {
      return reply.code(502).send({ error: String(err) });
    }
  });

  // Adding validates against the API first: the project must be readable and
  // must have a request-family status, or there is nothing to collect.
  app.post('/v1/qa/projects', async (req, reply) => {
    const body = (req.body ?? {}) as { projectId?: unknown };
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    if (!PROJECT_ID.test(projectId)) {
      return reply.code(400).send({ error: 'projectId must be a number' });
    }
    if (!poller.status().enabled) return reply.code(409).send({ poller: poller.status() });
    try {
      const project = await poller.addProject(projectId);
      // Its first items arrive with the poll that this kicks off; the console
      // keeps refreshing while `poller.running` is set.
      void poller.pollNow();
      return reply.code(201).send({ project });
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  // The post and its comments, read now. The console calls this when a post
  // is opened, so what is shown is what is on the board at that moment.
  app.post('/v1/qa/items/:postId/open', async (req, reply) => {
    const { postId } = req.params as { postId: string };
    if (!PROJECT_ID.test(postId)) return reply.code(400).send({ error: 'postId must be a number' });
    if (!poller.status().enabled) return reply.code(409).send({ poller: poller.status() });
    try {
      const item = await poller.openPost(postId);
      if (!item) return reply.code(404).send({ error: 'no such post' });
      return reply.send({ item });
    } catch (err) {
      return reply.code(502).send({ error: String(err) });
    }
  });

  // Ask the agent for a verdict on one post. Queued, not awaited: a verdict
  // takes as long as the agent takes, and the console polls for the result.
  app.post('/v1/qa/items/:postId/triage', async (req, reply) => {
    const { postId } = req.params as { postId: string };
    if (!PROJECT_ID.test(postId)) return reply.code(400).send({ error: 'postId must be a number' });
    if (!poller.status().enabled) return reply.code(409).send({ poller: poller.status() });
    if (!store.getItem(postId)) return reply.code(404).send({ error: 'no such post' });
    return reply.code(202).send({ queued: triage.enqueue(postId), triage: triage.status() });
  });

  // A person's lane for a post. Stored beside the agent's verdict, never over
  // it: the pair is what the triage rules are corrected from.
  app.put('/v1/qa/items/:postId/review', async (req, reply) => {
    const { postId } = req.params as { postId: string };
    if (!PROJECT_ID.test(postId)) return reply.code(400).send({ error: 'postId must be a number' });
    const body = (req.body ?? {}) as { lane?: unknown; note?: unknown; by?: unknown };
    const lane = String(body.lane ?? '').toUpperCase();
    if (!(QA_LANES as readonly string[]).includes(lane)) {
      return reply.code(400).send({ error: `lane must be one of ${QA_LANES.join(', ')}` });
    }
    const item = store.getItem(postId);
    if (!item) return reply.code(404).send({ error: 'no such post' });
    const saved = store.saveReview(postId, {
      lane: lane as QaLane,
      agentLane: item.triage?.lane ?? null,
      note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '',
      by: typeof body.by === 'string' ? body.by.trim().slice(0, 60) : '',
      at: new Date().toISOString(),
      version: item.version,
    });
    return reply.send({ item: saved });
  });

  app.delete('/v1/qa/items/:postId/review', async (req, reply) => {
    const { postId } = req.params as { postId: string };
    if (!PROJECT_ID.test(postId)) return reply.code(400).send({ error: 'postId must be a number' });
    const item = store.saveReview(postId, null);
    if (!item) return reply.code(404).send({ error: 'no such post' });
    return reply.send({ item });
  });

  app.delete('/v1/qa/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.removeProject(id)) return reply.code(404).send({ error: 'no such project' });
    return reply.send({ removed: id });
  });
}
