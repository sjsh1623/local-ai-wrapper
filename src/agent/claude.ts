import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { run } from '../util/exec.js';
import { consume, newState, summary } from './stream.js';
import type { StreamState, ToolActivity } from './stream.js';

const cfg = getConfig();

export interface AgentRun {
  ok: boolean;
  timedOut: boolean;
  files: number;
  turns: number;
  resultText: string | null;
  stderr: string;
}

export interface AgentOptions {
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  onTool?: (activity: ToolActivity, state: StreamState) => void;
}

/**
 * Wires the SigNoz MCP server in when one is configured.
 *
 * --strict-mcp-config is not optional here. HOME points at the mounted ~/.claude,
 * so without it Claude Code would also load whatever MCP servers the host user
 * has registered — personal mail, drive, chat — into an agent that is supposed to
 * see one observability backend and the checked-out repository.
 */
function mcpArgs(): string[] {
  if (!cfg.SIGNOZ_MCP_URL) return [];
  const config = JSON.stringify({
    mcpServers: { signoz: { type: 'http', url: cfg.SIGNOZ_MCP_URL } },
  });
  return ['--mcp-config', config, '--strict-mcp-config'];
}

function allowedTools(): string {
  // Granting the server by prefix rather than naming ~40 tools, which the SigNoz
  // server is free to rename between releases. Only added when MCP is actually on.
  const tools = [...cfg.CLAUDE_ALLOWED_TOOLS];
  if (cfg.SIGNOZ_MCP_URL) tools.push('mcp__signoz');
  return tools.join(',');
}

function claudeArgs(prompt: string): string[] {
  return [
    '--print',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...mcpArgs(),
    '--permission-mode',
    cfg.CLAUDE_PERMISSION_MODE,
    '--allowedTools',
    allowedTools(),
    // An allow list on its own was observed not to keep Bash out, so the deny
    // list is what actually closes the shell.
    '--disallowedTools',
    cfg.CLAUDE_DISALLOWED_TOOLS.join(','),
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
  delete env.BRANCHSMITH_GIT_TOKEN;
  delete env.FLOW_API_TOKEN;
  delete env.API_KEYS;
  delete env.SIGNOZ_WEBHOOK_PASS;
  // The MCP server holds the SigNoz credential and the agent talks to the MCP
  // server, so the agent itself never needs the key in its environment.
  delete env.SIGNOZ_API_KEY;
  return env;
}

/** Run the locally installed Claude Code over a prepared worktree. */
export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const state = newState();

  const result = await run(cfg.CLAUDE_BIN, claudeArgs(options.prompt), {
    cwd: options.cwd,
    env: agentEnv(),
    timeoutMs: cfg.AGENT_TIMEOUT_MS,
    signal: options.signal,
    onLine: (line) => {
      const activity = consume(state, line);
      if (!activity || !options.onTool) return;
      // Absolute worktree paths are noise in a Flow comment; show what a reader
      // of the repository would recognise.
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

function relativize(target: string, cwd: string): string {
  if (!target.startsWith(cwd)) return target;
  return target.slice(cwd.length).replace(/^\/+/, '') || '.';
}

/** Used by /readyz: is the binary there and does it have a usable session? */
export async function checkClaude(): Promise<{ ok: boolean; version: string; error?: string }> {
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
