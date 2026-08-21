export const STAGES = [
  'queued',
  'preparing',
  'branching',
  'planning',
  'editing',
  'verifying',
  'committing',
  'pushing',
  'pr_opened',
] as const;

export type Stage = (typeof STAGES)[number];

/** Index of a stage in the nine-step lifecycle, 1-based — the `n` in "[n/9]". */
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

export interface PrOptions {
  draft: boolean;
  labels: string[];
  reviewers: string[];
  title?: string;
}

export interface NotifyTarget {
  kind: 'flow' | 'webhook' | 'none';
  /** Flow post to comment on. Null means "create one and remember its number". */
  postId?: string | null;
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
  flowPostId: string | null;
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
}
