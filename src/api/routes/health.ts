import type { FastifyInstance } from 'fastify';
import { getConfig } from '../../config.js';
import { run } from '../../util/exec.js';
import { activeProvider, agentBin, checkAgent } from '../../agent/index.js';
import * as mcp from '../../agent/mcp.js';
import { checkToken } from '../../forge/github.js';
import { flowEnabled, mode as flowMode } from '../../notify/transports/flow.js';
import * as queue from '../../jobs/queue.js';
import * as store from '../../jobs/store.js';
import * as qaPoller from '../../qa/poller.js';

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
      headers: {
        'content-type': 'application/json',
        // Both types, not just JSON. A streamable-HTTP server answers 400
        // ("Not Acceptable") to an Accept header that omits text/event-stream,
        // which reads on /readyz as a broken endpoint rather than a probe that
        // asked wrongly — observed against signoz/signoz-mcp-server.
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'morningmate-alert-readyz', version: '1' },
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

    // Keyed by provider so a readyz payload says which agent it actually probed;
    // "claude: ok" while running Codex would be the wrong thing to page on.
    const agent = await checkAgent();
    checks[activeProvider()] = agent.ok
      ? { ok: true, detail: agent.version }
      : { ok: false, detail: agent.error ?? `${agentBin()} is not usable` };

    try {
      checks.github = { ok: true, detail: `authenticated as ${await checkToken()}` };
    } catch (err) {
      checks.github = { ok: false, detail: String(err) };
    }

    // The mode matters more than the fact that Flow is on: webhook mode cannot
    // change a task's status or comment on its thread, and that difference is
    // invisible from anywhere else.
    const flow = flowMode();
    const hooks = Object.keys(cfg.flowWebhooks).join(', ') || 'none';
    const detail: Record<typeof flow, string> = {
      api: `${cfg.FLOW_API_SURFACE} API · project ${cfg.FLOW_PROJECT_ID} · task, status and thread comments`,
      'v1+webhook':
        `v1 API · project ${cfg.FLOW_PROJECT_ID} · task and status. ` +
        `Updates go to the webhook (${hooks}) as separate items — /v1 has no comments endpoint. ` +
        'A personal key with FLOW_API_SURFACE=user makes them thread comments.',
      webhook:
        `incoming webhook (${hooks}) — registers tasks only. ` +
        'No id comes back, so status changes and comments are skipped.',
      disabled: 'disabled — no FLOW_API_KEY and no FLOW_WEBHOOK_URL',
    };
    checks.flow = { ok: true, detail: detail[flow] };
    void flowEnabled();

    checks.signozMcp = await checkSignozMcp();

    // Reported, never failed on. Stripe is offered to billing alerts only, so a
    // deployment with no key is a correct one for everybody else — flipping
    // /readyz to 503 over it would stop the whole instance from taking work.
    const stripe = mcp.configured('stripe');
    checks.stripeMcp = {
      ok: true,
      detail: stripe
        ? `${stripe.url} — offered to routes with \`mcp: [stripe]\``
        : 'not configured; billing alerts are diagnosed without Stripe (set STRIPE_MCP_KEY)',
    };

    // Reported, never failed on, for the same reason: QA intake is an extra,
    // and an instance without it is a complete alert service.
    const qa = qaPoller.status();
    checks.qa = {
      ok: true,
      detail: qa.enabled
        ? `polling ${Object.keys(qa.projects).length} project(s)` +
          (qa.lastError ? ` — ${qa.lastError}` : '')
        : `off — ${qa.reason}`,
    };

    const ok = Object.values(checks).every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ ok, checks, stats: store.statsToday() });
  });
}
