/**
 * Picks the agent backend. AGENT_PROVIDER is read once at boot, so a job cannot
 * start under one provider and finish under another.
 */
import { getConfig } from '../config.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import type { AgentCheck, AgentOptions, AgentProvider, AgentRun } from './types.js';

export type { AgentCheck, AgentOptions, AgentProvider, AgentRun } from './types.js';

const cfg = getConfig();

const backends = {
  claude: {
    runAgent: claude.runAgent,
    check: claude.check,
    bin: () => cfg.CLAUDE_BIN,
    label: 'Claude Code',
  },
  codex: {
    runAgent: codex.runAgent,
    check: codex.check,
    bin: () => cfg.CODEX_BIN,
    label: 'Codex',
  },
} as const;

export function activeProvider(): AgentProvider {
  return cfg.AGENT_PROVIDER;
}

export function agentBin(): string {
  return backends[cfg.AGENT_PROVIDER].bin();
}

/** Human-facing name for progress messages. */
export function agentLabel(): string {
  return backends[cfg.AGENT_PROVIDER].label;
}

export function runAgent(options: AgentOptions): Promise<AgentRun> {
  return backends[cfg.AGENT_PROVIDER].runAgent(options);
}

export function checkAgent(): Promise<AgentCheck> {
  return backends[cfg.AGENT_PROVIDER].check();
}
