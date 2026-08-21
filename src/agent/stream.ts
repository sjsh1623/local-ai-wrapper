/**
 * Parser for the NDJSON that `claude --print --output-format stream-json` emits.
 *
 * It is written to be tolerant on purpose: the exact envelope varies between
 * Claude Code releases, so anything unrecognised is ignored rather than fatal.
 * Only two things are actually load-bearing — which tool touched which file,
 * and the final result line.
 */

export interface ToolActivity {
  tool: string;
  target: string;
}

export interface StreamState {
  turns: number;
  tools: ToolActivity[];
  filesTouched: Set<string>;
  resultText: string | null;
  isError: boolean;
  unparsedLines: number;
}

export function newState(): StreamState {
  return {
    turns: 0,
    tools: [],
    filesTouched: new Set(),
    resultText: null,
    isError: false,
    unparsedLines: 0,
  };
}

function describeTarget(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const path = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof path === 'string') return path;
  if (typeof input.pattern === 'string') return `"${input.pattern}"`;
  if (typeof input.command === 'string') return String(input.command).slice(0, 80);
  if (typeof input.prompt === 'string') return String(input.prompt).slice(0, 60);
  return '';
}

/** Feed one line; returns the tool activity it described, if any. */
export function consume(state: StreamState, line: string): ToolActivity | null {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    state.unparsedLines++;
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'result') {
    state.resultText =
      typeof msg.result === 'string' ? msg.result : (state.resultText ?? null);
    state.isError = Boolean(msg.is_error) || msg.subtype === 'error';
    if (typeof msg.num_turns === 'number') state.turns = msg.num_turns;
    return null;
  }

  if (msg.type === 'assistant') {
    state.turns++;
    const content = msg.message?.content;
    if (!Array.isArray(content)) return null;
    let last: ToolActivity | null = null;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const tool = String(block.name ?? 'tool');
      const target = describeTarget(tool, block.input);
      const activity: ToolActivity = { tool, target };
      state.tools.push(activity);
      if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool) && target) {
        state.filesTouched.add(target);
      }
      last = activity;
    }
    return last;
  }

  return null;
}

export function summary(state: StreamState): { files: number; turns: number } {
  return { files: state.filesTouched.size, turns: state.turns };
}
