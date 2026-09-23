import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { run } from '../util/exec.js';
import { consume, newState, summary } from './stream.js';
import * as mcp from './mcp.js';
import { relativize } from './types.js';
import type { AgentCheck, AgentOptions, AgentRun } from './types.js';

const cfg = getConfig();


/**
 * Wires in the MCP servers this run was offered — see agent/mcp.ts.
 *
 * --strict-mcp-config is not optional here. HOME points at the mounted ~/.claude,
 * so without it Claude Code would also load whatever MCP servers the host user
 * has registered — personal mail, drive, chat — into an agent that is supposed to
 * see the sources this alert's route named and the checked-out repository.
 *
 * A bearer token goes inline in the header, which the Codex driver deliberately
 * avoids. It is tolerable here only because this driver denies Bash outright:
 * there is nothing running under it that could read its own argv.
 */
function mcpArgs(options: AgentOptions): string[] {
  const list = mcp.servers(options.mcp);
  if (!list.length) return [];
  const mcpServers: Record<string, unknown> = {};
  for (const server of list) {
    mcpServers[server.name] = server.token
      ? { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } }
      : { type: 'http', url: server.url };
  }
  return ['--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config'];
}

/** The writing tools, which a read-only pass has to be stripped of. */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

function allowedTools(options: AgentOptions): string {
  // Granting each server by prefix rather than naming ~40 tools, which a server
  // is free to rename between releases. Only the servers actually offered.
  const tools = [...cfg.CLAUDE_ALLOWED_TOOLS];
  for (const server of mcp.servers(options.mcp)) tools.push(`mcp__${server.name}`);
  const usable = options.readOnly ? tools.filter((tool) => !WRITE_TOOLS.includes(tool)) : tools;
  return usable.join(',');
}

function deniedTools(options: AgentOptions): string {
  // The allow list alone was observed not to keep a tool out, so a read-only
  // pass names the writers on the deny list as well.
  const denied = [...cfg.CLAUDE_DISALLOWED_TOOLS];
  if (options.readOnly) {
    for (const tool of WRITE_TOOLS) if (!denied.includes(tool)) denied.push(tool);
  }
  return denied.join(',');
}

function claudeArgs(prompt: string, options: AgentOptions): string[] {
  return [
    '--print',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...mcpArgs(options),
    '--permission-mode',
    cfg.CLAUDE_PERMISSION_MODE,
    '--allowedTools',
    allowedTools(options),
    // An allow list on its own was observed not to keep Bash out, so the deny
    // list is what actually closes the shell.
    '--disallowedTools',
    deniedTools(options),
    '--max-turns',
    String(cfg.CLAUDE_MAX_TURNS),
    '--model',
    cfg.CLAUDE_MODEL,
  ];
}

function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (cfg.CLAUDE_HOME) {
    // Claude Code reads its login session relative to HOME. Pointing HOME at
    // the mounted directory is what lets the container reuse the host session —
    // and why that mount has to be writable.
    env.HOME = cfg.CLAUDE_HOME.replace(/\/\.claude\/?$/, '') || env.HOME;
    env.CLAUDE_CONFIG_DIR = cfg.CLAUDE_HOME;
  }
  // The repository being edited must never inherit our own secrets.
  delete env.GITHUB_TOKEN;
  delete env.MORNINGMATE_ALERT_GIT_TOKEN;
  delete env.FLOW_API_KEY;
  delete env.API_KEYS;
  delete env.SIGNOZ_WEBHOOK_PASS;
  // The MCP server holds the SigNoz credential and the agent talks to the MCP
  // server, so the agent itself never needs the key in its environment.
  delete env.SIGNOZ_API_KEY;
  // The Stripe key travels in the MCP header this driver builds, never in the
  // environment the agent can read.
  delete env.STRIPE_MCP_KEY;
  return env;
}

/** Run the locally installed Claude Code over a prepared worktree. */
export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const state = newState();

  const result = await run(cfg.CLAUDE_BIN, claudeArgs(options.prompt, options), {
    cwd: options.cwd,
    env: agentEnv(),
    timeoutMs: options.timeoutMs ?? cfg.AGENT_TIMEOUT_MS,
    signal: options.signal,
    onLine: (line) => {
      const activity = consume(state, line);
      if (!activity || !options.onTool) return;
      options.onTool({ ...activity, target: relativize(activity.target, options.cwd) }, state);
    },
  });

  const { files, turns } = summary(state);

  if (state.unparsedLines > 0) {
    logger.debug(
      { unparsedLines: state.unparsedLines },
      'some agent output was not stream-json; check the installed claude version',
    );
  }

  return {
    ok: result.code === 0 && !state.isError,
    timedOut: result.timedOut,
    files,
    turns,
    resultText: state.resultText,
    stderr: result.stderr.trim().slice(-2000),
  };
}

/** Used by /readyz: is the binary there and does it have a usable session? */
export async function check(): Promise<AgentCheck> {
  try {
    const result = await run(cfg.CLAUDE_BIN, ['--version'], {
      env: agentEnv(),
      timeoutMs: 20_000,
    });
    if (result.code !== 0) {
      return { ok: false, version: '', error: result.stderr.trim() || `exit ${result.code}` };
    }
    return { ok: true, version: result.stdout.trim() };
  } catch (err) {
    return { ok: false, version: '', error: String(err) };
  }
}
