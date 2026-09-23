import { getConfig } from '../config.js';
import { logger } from '../logger.js';

const cfg = getConfig();

/**
 * Which MCP servers a run is allowed to see.
 *
 * There used to be exactly one — SigNoz — and a boolean was enough to say
 * whether a pass got it. Billing alerts broke that: diagnosing a failed charge
 * means reading the charge, and the answer is in Stripe rather than in the
 * traces. So the offer became a list, chosen per alert in `routes.yml`, and this
 * module is the single place that knows what a name maps to.
 *
 * Both drivers build their own flags from it, because they describe a server
 * differently — Codex writes `-c mcp_servers.<name>.url=…` into its config, and
 * Claude Code takes one `--mcp-config` JSON document — and neither should be
 * making decisions about *which* servers a job gets.
 */
export interface McpServer {
  name: string;
  url: string;
  /**
   * The environment variable the token is passed in, and the token itself.
   *
   * Both are needed because the two drivers want opposite things: Codex takes
   * only a variable name (`bearer_token_env_var`) and reads the value out of its
   * own environment, while Claude Code takes the header inline. Codex's way is
   * the better one — a token on argv is readable from /proc by anything the
   * agent runs, and Codex is the driver that has a shell.
   */
  tokenEnv?: string;
  token?: string;
}

/** What a run gets when it does not ask for anything in particular. */
export const DEFAULT_SERVERS: readonly string[] = ['signoz'];

/**
 * Everything this deployment could offer, by the name `routes.yml` uses.
 *
 * A server with no URL configured is simply absent, which is what makes
 * `SIGNOZ_MCP_URL=` and `STRIPE_MCP_KEY=` valid configurations rather than boot
 * failures: the agent then works without that source instead of not working.
 */
function catalog(): Record<string, McpServer> {
  const all: Record<string, McpServer> = {};

  if (cfg.SIGNOZ_MCP_URL) {
    all.signoz = { name: 'signoz', url: cfg.SIGNOZ_MCP_URL };
  }

  // Stripe's remote server authenticates with an ordinary API key over a bearer
  // header, so unlike the OAuth flow it documents first, this one works headless.
  // The key must be a *restricted, read-only* one: the agent that holds it has a
  // shell, and read access is the whole of what an investigation needs.
  if (cfg.STRIPE_MCP_URL && cfg.STRIPE_MCP_KEY) {
    all.stripe = {
      name: 'stripe',
      url: cfg.STRIPE_MCP_URL,
      tokenEnv: 'STRIPE_MCP_TOKEN',
      token: cfg.STRIPE_MCP_KEY,
    };
  }

  return all;
}

const warned = new Set<string>();

/**
 * Resolve requested names to configured servers.
 *
 * A name with nothing behind it is dropped with one warning, not an error. The
 * common way to get here is a `routes.yml` that asks for `stripe` on a
 * deployment where no key was set, and losing the Stripe lookups is a worse
 * investigation — never a reason to abandon the alert.
 */
export function servers(requested: readonly string[] = DEFAULT_SERVERS): McpServer[] {
  const all = catalog();
  const out: McpServer[] = [];
  for (const name of requested) {
    const server = all[name];
    if (!server) {
      if (!warned.has(name)) {
        warned.add(name);
        logger.warn(
          { server: name, configured: Object.keys(all) },
          'an MCP server was requested but is not configured; running without it',
        );
      }
      continue;
    }
    if (!out.some((s) => s.name === server.name)) out.push(server);
  }
  return out;
}

/** Whether a named server is usable at all — what /readyz reports. */
export function configured(name: string): McpServer | null {
  return catalog()[name] ?? null;
}

/**
 * The environment the drivers must add for these servers to authenticate.
 *
 * Returned separately from the flags so that a driver's environment scrubber
 * runs first: the raw `STRIPE_MCP_KEY` is deleted along with every other secret,
 * and only a run that was actually offered Stripe gets the token back under the
 * name its MCP configuration reads.
 */
export function tokenEnv(list: McpServer[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const server of list) {
    if (server.tokenEnv && server.token) env[server.tokenEnv] = server.token;
  }
  return env;
}
