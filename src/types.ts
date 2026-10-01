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

/**
 * One option of a project's status column.
 *
 * `category` is the family the option belongs to, and it is the same across
 * projects even though the names and ids are not: "0" request, "1" in
 * progress, "2" complete, "3" on hold. The console filters on it.
 */
export interface QaStatus {
  id: string;
  name: string;
  category: string;
}

/** A QA project the intake polls. */
export interface QaProject {
  projectId: string;
  title: string;
  statuses: QaStatus[];
  addedAt: string;
}

/**
 * Where a QA post goes after triage.
 *
 *   A1 — layout only (SCSS): fixable end to end
 *   A2 — wording / hard-coded text → i18n key: code fix plus a key list for a person
 *   B  — logic bug with a clear reproduction: analysis and a draft fix
 *   C  — one customer's account or data: investigation report only
 *   D  — a question, a request, another team's area, mobile: a person decides
 */
export const QA_LANES = ['A1', 'A2', 'B', 'C', 'D'] as const;
export type QaLane = (typeof QA_LANES)[number];

export interface QaTriage {
  lane: QaLane;
  confidence: 'high' | 'medium' | 'low';
  /** One line, in the reader's language, saying what the post is about. */
  summary: string;
  /** Why this lane — the facts in the post that decided it. */
  reasons: string[];
  /** What a fix would need that the post does not give. */
  missing: string[];
  at: string;
  /** The row version the verdict was made on; a changed post gets a new one. */
  version: string;
  provider: string;
  elapsedMs: number;
}

/** One comment on a QA post, as the comments endpoint returns it. */
export interface QaComment {
  id: string;
  authorId: string;
  authorName: string;
  /** Flow's own `yyyyMMddHHmmss`, kept as it arrived — the API does not say which zone. */
  at: string;
  text: string;
  /** Status and assignee changes are comments too; this tells them apart from a person's. */
  system: boolean;
  images: string[];
}

/**
 * A QA task waiting in the intake queue.
 *
 * This is deliberately not a `Job`. A job is work this service has agreed to
 * do; a QA item is something it has only read. Nothing here is acted on until a
 * later stage turns one into a `JobRequest`.
 */
export interface QaItem {
  postId: string;
  taskId: string;
  projectId: string;
  title: string;
  body: string;
  url: string;
  section: string | null;
  statusId: string;
  statusName: string;
  /** See QaStatus.category. */
  statusCategory: string;
  assignees: Array<{ id: string; name: string }>;
  /** Custom column values by column name — Issue Type, Reproducibility, Region… */
  columns: Record<string, string[]>;
  registerName: string;
  registeredAt: string;
  images: string[];
  attachments: Array<{ name: string; size: number | null }>;
  /** A recording is evidence the agent cannot open; triage needs to know it exists. */
  hasVideo: boolean;
  /**
   * Read on demand, when someone opens the post on the console — not by the
   * poller: the body, attachments and comments. `detailAt` is when, and
   * `detailVersion` the row version they belong to, so a post edited since is
   * read again on the next open.
   */
  comments: QaComment[];
  detailAt: string | null;
  detailVersion: string | null;
  /** The agent's verdict, or null until one is asked for. */
  triage: QaTriage | null;
  /** Why the last attempt produced no verdict. */
  triageError: string | null;
  /**
   * Changes whenever the task row does — a status move, an edit. What makes a
   * Re-request a new piece of work rather than one already seen.
   */
  version: string;
  /** `gone` once it is no longer assigned to the intake account. */
  state: 'open' | 'gone';
  firstSeenAt: string;
  updatedAt: string;
  lastSeenAt: string;
}
