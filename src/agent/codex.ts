import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { run } from '../util/exec.js';
import { newState, summary } from './stream.js';
import { consume } from './codex-stream.js';
import * as mcp from './mcp.js';
import { relativize } from './types.js';
import type { AgentCheck, AgentOptions, AgentRun } from './types.js';

const cfg = getConfig();

/**
 * Wires in the MCP servers this run was offered — see agent/mcp.ts.
 *
 * A bare `url` is the whole declaration for a streamable-HTTP server — that is
 * what `codex mcp add <name> --url <url>` writes into config.toml, and inventing
 * a `transport` key alongside it would be rejected under --strict-config.
 *
 * `bearer_token_env_var` names the variable rather than carrying the token,
 * which is the point: argv is world-readable out of /proc, and this driver is
 * the one that hands the agent a shell.
 */
function mcpArgs(options: AgentOptions): string[] {
  const args: string[] = [];
  for (const server of mcp.servers(options.mcp)) {
    args.push('-c', `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`);
    if (server.tokenEnv) {
      args.push(
        '-c',
        `mcp_servers.${server.name}.bearer_token_env_var=${JSON.stringify(server.tokenEnv)}`,
      );
    }
  }
  return args;
}

function codexArgs(prompt: string, lastMessageFile: string, options: AgentOptions): string[] {
  const args = [
    'exec',
    '--json',
    '--sandbox',
    // A read-only pass must not be able to write: the triage and root-cause
    // stages exist to produce text, and anything they changed would be swept
    // into the commit that a later stage makes on someone else's behalf.
    options.readOnly ? 'read-only' : cfg.CODEX_SANDBOX,
    // The final answer, written straight to a file. Parsing it out of the event
    // stream also works, but this survives a future release reshaping the stream.
    '--output-last-message',
    lastMessageFile,
  ];

  // CODEX_HOME is the host's mounted ~/.codex, so without this the agent would
  // also inherit whatever config.toml the host user keeps there — personal MCP
  // servers, a different sandbox policy, a different model. This is the
  // counterpart to --strict-mcp-config in the Claude driver. Auth still resolves
  // through CODEX_HOME either way.
  if (cfg.CODEX_IGNORE_USER_CONFIG) args.push('--ignore-user-config');

  // See AgentOptions.allowUntrackedCwd — Codex will not start in a directory
  // that is not a git repository unless told to.
  if (options.allowUntrackedCwd) args.push('--skip-git-repo-check');

  // Left empty by default on purpose: Codex picks its own current default model,
  // which survives a release renaming the one we would otherwise have pinned.
  if (cfg.CODEX_MODEL) args.push('--model', cfg.CODEX_MODEL);
  if (cfg.CODEX_REASONING_EFFORT) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(cfg.CODEX_REASONING_EFFORT)}`);
  }
  args.push(...mcpArgs(options), ...cfg.CODEX_EXTRA_ARGS);

  // The prompt goes last, positionally. Long prompts are fine — ours are tens of
  // kilobytes against a ~2MB argv limit.
  args.push(prompt);
  return args;
}

function agentEnv(options: AgentOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (cfg.CODEX_HOME) {
    // Codex keeps its login session and config under CODEX_HOME (default ~/.codex).
    // Pointing it at the mounted directory is what lets the container reuse the
    // host `codex login` session — and why that mount has to be writable.
    env.CODEX_HOME = cfg.CODEX_HOME;
  }
  // Only present when the operator chose API-key auth over a login session.
  if (cfg.OPENAI_API_KEY) env.OPENAI_API_KEY = cfg.OPENAI_API_KEY;
  else delete env.OPENAI_API_KEY;

  // The repository being edited must never inherit our own secrets. Codex has a
  // shell, so this matters more here than it does for the Claude driver, where
  // Bash is denied outright.
  delete env.GITHUB_TOKEN;
  delete env.MORNINGMATE_ALERT_GIT_TOKEN;
  delete env.FLOW_API_KEY;
  delete env.API_KEYS;
  delete env.SIGNOZ_WEBHOOK_PASS;
  delete env.WEBHOOK_SECRET;
  // The MCP server holds the SigNoz credential and the agent talks to the MCP
  // server, so the agent itself never needs the key in its environment.
  delete env.SIGNOZ_API_KEY;
  // Unlike SigNoz, the Stripe server is reached directly and the credential is
  // the agent's to present. It is deleted under its configured name and handed
  // back below only to a run that was actually offered Stripe — an alert about
  // the Java WAS has no business carrying a payments key into a shell.
  delete env.STRIPE_MCP_KEY;
  Object.assign(env, mcp.tokenEnv(mcp.servers(options.mcp)));
  return env;
}

/** Run the locally installed Codex CLI over a prepared worktree. */
export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const state = newState();

  // Outside the worktree on purpose — anything written inside it would show up
  // as a change to commit.
  const scratch = await mkdtemp(join(tmpdir(), 'morningmate-alert-'));
  const lastMessageFile = join(scratch, 'last-message.txt');

  let result;
  try {
    result = await run(cfg.CODEX_BIN, codexArgs(options.prompt, lastMessageFile, options), {
      cwd: options.cwd,
      env: agentEnv(options),
      timeoutMs: options.timeoutMs ?? cfg.AGENT_TIMEOUT_MS,
      signal: options.signal,
      // Codex appends piped stdin to the prompt, so it waits on the pipe we hand
      // it. An empty string closes it immediately; leaving it open hangs the run
      // until AGENT_TIMEOUT_MS with no output at all.
      input: '',
      onLine: (line) => {
        const activity = consume(state, line);
        if (!activity || !options.onTool) return;
        options.onTool({ ...activity, target: relativize(activity.target, options.cwd) }, state);
      },
    });

    const written = await readFile(lastMessageFile, 'utf8').catch(() => '');
    if (written.trim()) state.resultText = written.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const { files, turns } = summary(state);

  if (state.unparsedLines > 0) {
    logger.debug(
      { unparsedLines: state.unparsedLines },
      'some agent output was not JSON; check the installed codex version',
    );
  }

  return {
    ok: result.code === 0 && !state.isError,
    timedOut: result.timedOut,
    files,
    // A Codex run is one turn from our side; report at least 1 so the progress
    // line does not read "0턴" for work that plainly happened.
    turns: Math.max(turns, 1),
    resultText: state.resultText,
    stderr: result.stderr.trim().slice(-2000),
  };
}

/** Used by /readyz: is the binary there and does it have a usable session? */
export async function check(): Promise<AgentCheck> {
  try {
    const result = await run(cfg.CODEX_BIN, ['--version'], {
      // A version probe talks to nothing, so it is offered no MCP server and
      // therefore carries no token.
      env: agentEnv({ cwd: '.', prompt: '', mcp: [] }),
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
