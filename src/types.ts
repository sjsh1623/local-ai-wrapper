export const STAGES = [
  'queued',
  // Codex reads the raw alert and writes the one paragraph a person would
  // want in a task tracker. Everything downstream quotes its output.
  'triaging',
  // The Flow task is created here and immediately moved to "in progress".
  'registering',
  'preparing',
  'branching',
  // Codex goes back to SigNoz through MCP and works out *why* it fired.
  'analyzing',
  'editing',
  'verifying',
  'committing',
  'pushing',
  'pr_opened',
] as const;

export type Stage = (typeof STAGES)[number];

/** How many steps the pipeline has — the denominator in "[n/N]". */
export const STAGE_COUNT = STAGES.length;

/** Index of a stage in the lifecycle, 1-based — the `n` in "[n/N]". */
export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage) + 1;
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'no_changes'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const TERMINAL_STATUSES: JobStatus[] = [
  'succeeded',
  'no_changes',
  'failed',
  'cancelled',
  'timed_out',
];

export type EventStatus = 'started' | 'running' | 'done' | 'failed';

export type Locale = 'ko' | 'en';

/** The five states a Flow task can be in. See https://api.flow.team/docs. */
export const FLOW_STATUSES = ['request', 'progress', 'feedback', 'complete', 'hold'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

export interface PrOptions {
  draft: boolean;
  labels: string[];
  reviewers: string[];
  title?: string;
}

export interface NotifyTarget {
  kind: 'flow' | 'webhook' | 'none';
  /** Flow project the task is registered in. Null falls back to FLOW_PROJECT_ID. */
  projectId?: string | null;
  /** An existing Flow task to reuse instead of registering a new one. */
  taskId?: string | null;
  /** The post behind that task — what comments are addressed to. */
  postId?: string | null;
  /** Flow ids to assign as workers. Null falls back to FLOW_WORKERS. */
  workers?: string[] | null;
  /**
   * Named Flow webhook endpoint to post to (webhook mode only). Null means
   * `default`. This is how billing alerts keep their own room.
   */
  webhook?: string | null;
  /** Webhook override; falls back to WEBHOOK_URL. */
  url?: string | null;
}

/** The one contract every inbound adapter normalizes to. */
export interface JobRequest {
  repo: string;
  base: string;
  branch: string | null;
  instruction: string;
  context: Record<string, string>;
  verify: string[];
  /**
   * Extra MCP servers the agent may use on this alert, beyond SigNoz — the
   * names in agent/mcp.ts, chosen per route. Billing alerts carry `stripe`.
   */
  mcp: string[];
  pr: PrOptions;
  notify: NotifyTarget;
  locale: Locale;
  dryRun: boolean;
  idempotencyKey: string | null;
}

export interface Job extends JobRequest {
  id: string;
  status: JobStatus;
  stage: Stage;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  prUrl: string | null;
  /** Flow project the task actually landed in — resolved once, at registration. */
  flowProjectId: string | null;
  flowTaskId: string | null;
  flowPostId: string | null;
  /** Flow's own short link to the task, handed back by the create call. */
  flowUrl: string | null;
  /** Codex's triage summary, as the plain text that was posted to Flow. */
  summary: string | null;
  /** Codex's root-cause report, as the plain text that was posted to Flow. */
  analysis: string | null;
  filesChanged: number;
  error: string | null;
}

export interface JobEvent {
  jobId: string;
  seq: number;
  stage: Stage;
  status: EventStatus;
  progress: number;
  locale: Locale;
  text: string;
  data: Record<string, unknown>;
  ts: string;
}

/** What a stage handler hands to the notifier before rendering. */
export interface EmitInput {
  stage: Stage;
  status: EventStatus;
  key: string;
  params?: Record<string, string | number>;
  data?: Record<string, unknown>;
  /**
   * A whole document — a triage summary, a root-cause report — to post instead
   * of the one-line `key` rendering. The line still goes to the log and SSE.
   */
  body?: string;
}

/**
 * Context fields meant for a reader.
 *
 * Underscore-prefixed keys hold the raw webhook body. The console renders that
 * on its own, folded away; anywhere else it is a JSON blob pasted into prose —
 * the agent's prompt and the pull request description both used to carry one.
 */
export function displayContext(context: Record<string, string>): Array<[string, string]> {
  return Object.entries(context).filter(([key]) => !key.startsWith('_'));
}
