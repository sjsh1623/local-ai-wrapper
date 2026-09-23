/**
 * The contract every agent backend implements.
 *
 * It lives in its own module so `claude.ts` and `codex.ts` can both depend on it
 * without either importing the other, and so `index.ts` can dispatch between them.
 */
import type { StreamState, ToolActivity } from './stream.js';

export type AgentProvider = 'claude' | 'codex';

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
  /**
   * Investigate without editing. The triage and root-cause passes both run this
   * way: they exist to produce text, and a stray edit from either would be
   * committed later by the stage that *is* allowed to edit, with no reviewer
   * ever having seen it attributed.
   */
  readOnly?: boolean;
  /** Overrides AGENT_TIMEOUT_MS for the short passes that bracket the edit. */
  timeoutMs?: number;
  /**
   * Which MCP servers this run may use, by the names agent/mcp.ts knows.
   *
   * Undefined means SigNoz alone, which is what every pass wanted back when
   * SigNoz was the only server there was. Callers name the list when they want
   * something else: triage drops SigNoz to stay fast, and a billing alert adds
   * `stripe` because the charge it is about is not in the traces. Names with
   * nothing configured behind them are dropped with a warning, not an error.
   */
  mcp?: readonly string[];
  /**
   * Let the run start in a directory that is not a git repository.
   *
   * Codex refuses one by default — "Not inside a trusted directory" — which is
   * the right guard for a pass that edits code, and wrong for triage, whose
   * whole point is to work from an empty scratch directory with no repository
   * anywhere near it. It fails in about 300ms, so without this the summary
   * silently falls back to the raw alert on every single alert.
   */
  allowUntrackedCwd?: boolean;
}

export interface AgentCheck {
  ok: boolean;
  version: string;
  error?: string;
}

/** Worktree paths are noise in a Flow comment; show what a reader would recognise. */
export function relativize(target: string, cwd: string): string {
  if (!target.startsWith(cwd)) return target;
  return target.slice(cwd.length).replace(/^\/+/, '') || '.';
}
