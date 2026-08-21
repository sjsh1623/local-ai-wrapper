import type { FastifyInstance } from 'fastify';
import { getConfig } from '../../config.js';
import { run } from '../../util/exec.js';
import { checkClaude } from '../../agent/claude.js';
import { checkToken } from '../../forge/github.js';
import { flowEnabled } from '../../notify/transports/flow.js';
import * as queue from '../../jobs/queue.js';
import * as store from '../../jobs/store.js';

const cfg = getConfig();

/**
 * A reachability probe, not a protocol handshake: the MCP endpoint is stateless
 * JSON-over-POST, so an `initialize` round trip is the cheapest thing that proves
 * the agent will actually be able to talk to it. A wrong URL and a dead container
 * look identical from the agent's side otherwise — it just silently loses SigNoz.
 */
async function checkSignozMcp(): Promise<{ ok: boolean; detail?: string }> {
  if (!cfg.SIGNOZ_MCP_URL) {
    return { ok: true, detail: 'disabled — SIGNOZ_MCP_URL is empty' };
  }
  try {
    const res = await fetch(cfg.SIGNOZ_MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'branchsmith-readyz', version: '1' },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `${cfg.SIGNOZ_MCP_URL} → HTTP ${res.status}` };
    return { ok: true, detail: cfg.SIGNOZ_MCP_URL };
  } catch (err) {
    return { ok: false, detail: `${cfg.SIGNOZ_MCP_URL} → ${String(err)}` };
  }
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: is the process up. Deliberately does no I/O.
  app.get('/healthz', async (_req, reply) =>
    reply.send({ ok: true, running: queue.runningCount(), pending: queue.pendingCount() }),
  );

  // Readiness: can this instance actually complete a job end to end?
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    const git = await run('git', ['--version'], { timeoutMs: 10_000 }).catch((err) => ({
      code: -1,
      stdout: '',
      stderr: String(err),
      timedOut: false,
    }));
    checks.git = { ok: git.code === 0, detail: git.stdout.trim() || git.stderr.trim() };

    const claude = await checkClaude();
    checks.claude = claude.ok
      ? { ok: true, detail: claude.version }
      : { ok: false, detail: claude.error };

    try {
      checks.github = { ok: true, detail: `authenticated as ${await checkToken()}` };
    } catch (err) {
      checks.github = { ok: false, detail: String(err) };
    }

    checks.flow = flowEnabled()
      ? { ok: true, detail: cfg.FLOW_API_BASE }
      : { ok: true, detail: 'disabled — FLOW_API_BASE is empty' };

    checks.signozMcp = await checkSignozMcp();

    const ok = Object.values(checks).every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ ok, checks, stats: store.statsToday() });
  });
}
