import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../config.js';
import type { Job, JobEvent, JobRequest, JobStatus, Stage } from '../types.js';

const cfg = getConfig();
mkdirSync(dirname(cfg.dbPath), { recursive: true });

const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL,
  stage           TEXT NOT NULL,
  repo            TEXT NOT NULL,
  base            TEXT NOT NULL,
  branch          TEXT,
  instruction     TEXT NOT NULL,
  context         TEXT NOT NULL DEFAULT '{}',
  verify          TEXT NOT NULL DEFAULT '[]',
  pr              TEXT NOT NULL DEFAULT '{}',
  notify          TEXT NOT NULL DEFAULT '{}',
  locale          TEXT NOT NULL DEFAULT 'ko',
  dry_run         INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  pr_url          TEXT,
  flow_post_id    TEXT,
  files_changed   INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS events (
  job_id   TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  stage    TEXT NOT NULL,
  status   TEXT NOT NULL,
  progress REAL NOT NULL,
  locale   TEXT NOT NULL,
  text     TEXT NOT NULL,
  data     TEXT NOT NULL DEFAULT '{}',
  ts       TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  transport TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  attempts  INTEGER NOT NULL,
  error     TEXT,
  ts        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts DESC);
`);

type Row = Record<string, any>;

function toJob(r: Row): Job {
  return {
    id: r.id,
    status: r.status as JobStatus,
    stage: r.stage as Stage,
    repo: r.repo,
    base: r.base,
    branch: r.branch,
    instruction: r.instruction,
    context: JSON.parse(r.context),
    verify: JSON.parse(r.verify),
    pr: JSON.parse(r.pr),
    notify: JSON.parse(r.notify),
    locale: r.locale,
    dryRun: !!r.dry_run,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    prUrl: r.pr_url,
    flowPostId: r.flow_post_id,
    filesChanged: r.files_changed,
    error: r.error,
  };
}

const insertJob = db.prepare(`
  INSERT INTO jobs (id, status, stage, repo, base, branch, instruction, context, verify, pr,
                    notify, locale, dry_run, idempotency_key, created_at)
  VALUES (@id, 'queued', 'queued', @repo, @base, @branch, @instruction, @context, @verify, @pr,
          @notify, @locale, @dry_run, @idempotency_key, @created_at)
`);

export function createJob(id: string, req: JobRequest): Job {
  insertJob.run({
    id,
    repo: req.repo,
    base: req.base,
    branch: req.branch,
    instruction: req.instruction,
    context: JSON.stringify(req.context),
    verify: JSON.stringify(req.verify),
    pr: JSON.stringify(req.pr),
    notify: JSON.stringify(req.notify),
    locale: req.locale,
    dry_run: req.dryRun ? 1 : 0,
    idempotency_key: req.idempotencyKey,
    created_at: new Date().toISOString(),
  });
  return getJob(id)!;
}

const selectJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
export function getJob(id: string): Job | null {
  const row = selectJob.get(id) as Row | undefined;
  return row ? toJob(row) : null;
}

const selectByKey = db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?');
export function getJobByIdempotencyKey(key: string): Job | null {
  const row = selectByKey.get(key) as Row | undefined;
  return row ? toJob(row) : null;
}

export function listJobs(opts: { status?: JobStatus; repo?: string; limit?: number } = {}): Job[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts.repo) { where.push('repo = ?'); params.push(opts.repo); }
  const sql =
    'SELECT * FROM jobs' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  params.push(opts.limit ?? 50);
  return (db.prepare(sql).all(...params) as Row[]).map(toJob);
}

const patchable: Record<string, string> = {
  status: 'status',
  stage: 'stage',
  branch: 'branch',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  prUrl: 'pr_url',
  flowPostId: 'flow_post_id',
  filesChanged: 'files_changed',
  error: 'error',
};

export function updateJob(id: string, patch: Partial<Job>): void {
  const sets: string[] = [];
  const params: any[] = [];
  for (const [key, column] of Object.entries(patchable)) {
    if (key in patch) {
      sets.push(`${column} = ?`);
      params.push((patch as any)[key]);
    }
  }
  if (!sets.length) return;
  params.push(id);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

const nextSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE job_id = ?');
const insertEvent = db.prepare(`
  INSERT INTO events (job_id, seq, stage, status, progress, locale, text, data, ts)
  VALUES (@job_id, @seq, @stage, @status, @progress, @locale, @text, @data, @ts)
`);

export function appendEvent(e: Omit<JobEvent, 'seq'>): JobEvent {
  const seq = (nextSeqStmt.get(e.jobId) as { n: number }).n;
  const full: JobEvent = { ...e, seq };
  insertEvent.run({
    job_id: e.jobId,
    seq,
    stage: e.stage,
    status: e.status,
    progress: e.progress,
    locale: e.locale,
    text: e.text,
    data: JSON.stringify(e.data),
    ts: e.ts,
  });
  return full;
}

function toEvent(r: Row): JobEvent {
  return {
    jobId: r.job_id,
    seq: r.seq,
    stage: r.stage,
    status: r.status,
    progress: r.progress,
    locale: r.locale,
    text: r.text,
    data: JSON.parse(r.data),
    ts: r.ts,
  };
}

export function listEvents(jobId: string, afterSeq = 0): JobEvent[] {
  return (
    db
      .prepare('SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq')
      .all(jobId, afterSeq) as Row[]
  ).map(toEvent);
}

/** Recent events across all jobs — what the console replays on reconnect. */
export function recentEvents(limit = 200): JobEvent[] {
  return (
    db.prepare('SELECT * FROM events ORDER BY ts DESC, seq DESC LIMIT ?').all(limit) as Row[]
  )
    .map(toEvent)
    .reverse();
}

export function recordDelivery(
  jobId: string,
  seq: number,
  transport: string,
  ok: boolean,
  attempts: number,
  error: string | null,
): void {
  db.prepare(
    `INSERT INTO deliveries (job_id, seq, transport, ok, attempts, error, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobId, seq, transport, ok ? 1 : 0, attempts, error, new Date().toISOString());
}

export function failedDeliveries(jobId: string): Row[] {
  return db
    .prepare('SELECT * FROM deliveries WHERE job_id = ? AND ok = 0 ORDER BY id')
    .all(jobId) as Row[];
}

export function statsToday(): { running: number; queued: number; done: number; failed: number } {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const iso = since.toISOString();
  const one = (sql: string, ...p: any[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  return {
    running: one("SELECT COUNT(*) n FROM jobs WHERE status = 'running'"),
    queued: one("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'"),
    done: one(
      "SELECT COUNT(*) n FROM jobs WHERE status IN ('succeeded','no_changes') AND finished_at >= ?",
      iso,
    ),
    failed: one(
      "SELECT COUNT(*) n FROM jobs WHERE status IN ('failed','timed_out') AND finished_at >= ?",
      iso,
    ),
  };
}

/**
 * A job left `running` by a crash can never resume mid-worktree, so on boot we
 * mark it failed rather than pretending it is still alive.
 */
export function reconcileOnBoot(): number {
  const res = db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = 'interrupted by a server restart',
       finished_at = ? WHERE status = 'running'`,
    )
    .run(new Date().toISOString());
  return res.changes;
}

export function queuedJobs(): Job[] {
  return (
    db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at").all() as Row[]
  ).map(toJob);
}

export { db };
