/**
 * Parser for the NDJSON that `codex exec --json` emits.
 *
 * Written to the same rule as stream.ts — tolerant on purpose — but it has to be
 * more so, because Codex has shipped two different envelopes:
 *
 *   older, protocol events:  {"id":"0","msg":{"type":"agent_message","message":"…"}}
 *   newer, thread items:     {"type":"item.completed","item":{"item_type":"…"}}
 *
 * Both are handled below and anything unrecognised is counted, not fatal. Only
 * two things are load-bearing: the final assistant message and whether the turn
 * failed. File counts here are for the progress line only — the authoritative
 * number comes from `git` in workspace/worktree.ts, so a schema drift in a future
 * Codex release degrades the console output without affecting the result.
 */
import type { StreamState, ToolActivity } from './stream.js';

function pathsFromChanges(changes: unknown): string[] {
  // newer: [{path, kind}]   older: {"/abs/path": {update: {...}}}
  if (Array.isArray(changes)) {
    return changes
      .map((c) => (c && typeof c === 'object' ? (c as any).path : null))
      .filter((p): p is string => typeof p === 'string');
  }
  if (changes && typeof changes === 'object') {
    return Object.keys(changes as Record<string, unknown>);
  }
  return [];
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 80);
  if (Array.isArray(value)) return value.join(' ').slice(0, 80);
  return '';
}

/** Records a file edit and returns the activity to surface. */
function fileChange(state: StreamState, paths: string[]): ToolActivity | null {
  let last: ToolActivity | null = null;
  for (const path of paths) {
    state.filesTouched.add(path);
    last = { tool: 'Edit', target: path };
    state.tools.push(last);
  }
  return last;
}

/** Newer envelope: {"type":"item.…","item":{…}} plus turn/thread lifecycle events. */
function consumeItemEvent(state: StreamState, msg: any): ToolActivity | null {
  const type = String(msg.type);

  if (type === 'turn.failed') {
    state.isError = true;
    const message = msg.error?.message ?? msg.message;
    if (typeof message === 'string') state.resultText = message;
    return null;
  }

  // Observed on codex-cli 0.149.1: transient retries are reported as top-level
  // `error` events ("Reconnecting... 2/5"), and the run still goes on to succeed.
  // Keep the text for a failure message but never let it decide the outcome —
  // the process exit code does that.
  if (type === 'error') {
    if (typeof msg.message === 'string') state.resultText ??= msg.message;
    return null;
  }

  if (type === 'turn.completed') {
    state.turns++;
    return null;
  }

  const item = msg.item;
  if (!item || typeof item !== 'object') return null;
  // `item_type` is the newer field name; `type` was used briefly.
  const kind = String(item.item_type ?? item.type ?? '');

  // Errors also arrive wrapped as items; same rule as above.
  if (kind === 'error') {
    if (typeof item.message === 'string') state.resultText ??= item.message;
    return null;
  }

  if (kind === 'agent_message') {
    const text = item.text ?? item.message;
    // Keep the last one: Codex may emit several before the turn ends.
    if (typeof text === 'string' && text.trim()) state.resultText = text;
    return null;
  }

  if (type !== 'item.completed' && type !== 'item.started') return null;

  if (kind === 'file_change' || kind === 'patch_apply') {
    return fileChange(state, pathsFromChanges(item.changes));
  }

  if (kind === 'command_execution') {
    const target = commandText(item.command);
    const activity: ToolActivity = { tool: 'Bash', target };
    state.tools.push(activity);
    return activity;
  }

  if (kind === 'mcp_tool_call') {
    const activity: ToolActivity = {
      tool: String(item.tool ?? item.server ?? 'mcp'),
      target: commandText(item.arguments),
    };
    state.tools.push(activity);
    return activity;
  }

  return null;
}

/** Older envelope: {"id":"…","msg":{"type":"…"}} */
function consumeProtocolEvent(state: StreamState, msg: any): ToolActivity | null {
  const type = String(msg.type ?? '');

  switch (type) {
    case 'agent_message': {
      const text = msg.message ?? msg.text;
      if (typeof text === 'string' && text.trim()) state.resultText = text;
      return null;
    }
    case 'task_complete': {
      state.turns++;
      const text = msg.last_agent_message;
      if (typeof text === 'string' && text.trim()) state.resultText = text;
      return null;
    }
    case 'error':
    case 'stream_error': {
      // Same reasoning as the newer envelope: diagnostic only, not a verdict.
      if (typeof msg.message === 'string') state.resultText ??= msg.message;
      return null;
    }
    case 'patch_apply_begin':
      return fileChange(state, pathsFromChanges(msg.changes));
    case 'exec_command_begin': {
      const activity: ToolActivity = { tool: 'Bash', target: commandText(msg.command) };
      state.tools.push(activity);
      return activity;
    }
    default:
      return null;
  }
}

/** Feed one line; returns the tool activity it described, if any. */
export function consume(state: StreamState, line: string): ToolActivity | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    // Codex prints a human-readable banner before the stream in some versions.
    state.unparsedLines++;
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;

  if (msg.msg && typeof msg.msg === 'object') return consumeProtocolEvent(state, msg.msg);
  if (typeof msg.type === 'string') return consumeItemEvent(state, msg);
  return null;
}
