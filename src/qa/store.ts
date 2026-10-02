import { db } from '../jobs/store.js';
import type { QaComment, QaItem, QaProject, QaReview, QaTriage } from '../types.js';
import type { Detail, RowItem } from './client.js';

type Row = Record<string, any>;

/**
 * QA items live beside the jobs rather than in them: an item is something read
 * from the QA project, and most will never become a job at all. The columns
 * are the ones something filters or compares on; the rest of the item is the
 * `data` document.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS qa_items (
  post_id       TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  status_id     TEXT NOT NULL,
  version       TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open',
  data          TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qa_state ON qa_items(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS qa_projects (
  project_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  statuses   TEXT NOT NULL DEFAULT '[]',
  added_at   TEXT NOT NULL
);
`);

// The first cut of this table kept only the "waiting" status ids. A database
// from that day is rebuilt rather than migrated: the table never left one
// machine, and the seed project comes back from the environment on the next
// poll. Anything added by hand in between has to be added again.
if (
  !(db.prepare('PRAGMA table_info(qa_projects)').all() as Row[]).some((c) => c.name === 'statuses')
) {
  db.exec(`DROP TABLE qa_projects;
CREATE TABLE qa_projects (
  project_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  statuses   TEXT NOT NULL DEFAULT '[]',
  added_at   TEXT NOT NULL
);`);
}

// Added after the first cut; see jobs/store.ts for why ALTER rather than a
// fresh CREATE. Rows from before carry '' until their next re-read, which the
// version bump in client.ts makes happen on the next poll.
if (
  !(db.prepare('PRAGMA table_info(qa_items)').all() as Row[]).some((c) => c.name === 'status_category')
) {
  db.exec("ALTER TABLE qa_items ADD COLUMN status_category TEXT NOT NULL DEFAULT ''");
}

/* ── projects ──────────────────────────────────────────────── */

function toProject(r: Row): QaProject {
  return {
    projectId: r.project_id,
    title: r.title,
    statuses: JSON.parse(r.statuses),
    addedAt: r.added_at,
  };
}

export function listProjects(): QaProject[] {
  return (db.prepare('SELECT * FROM qa_projects ORDER BY added_at').all() as Row[]).map(toProject);
}

export function getProject(projectId: string): QaProject | null {
  const row = db.prepare('SELECT * FROM qa_projects WHERE project_id = ?').get(projectId) as
    | Row
    | undefined;
  return row ? toProject(row) : null;
}

/** Add a project, or refresh the title and statuses of one already there. */
export function saveProject(p: Omit<QaProject, 'addedAt'>, now: string): QaProject {
  db.prepare(
    `INSERT INTO qa_projects (project_id, title, statuses, added_at)
     VALUES (@projectId, @title, @statuses, @now)
     ON CONFLICT(project_id) DO UPDATE SET title = excluded.title, statuses = excluded.statuses`,
  ).run({ projectId: p.projectId, title: p.title, statuses: JSON.stringify(p.statuses), now });
  return getProject(p.projectId)!;
}

/** Drop a project and everything read from it. */
export function removeProject(projectId: string): boolean {
  db.prepare('DELETE FROM qa_items WHERE project_id = ?').run(projectId);
  return db.prepare('DELETE FROM qa_projects WHERE project_id = ?').run(projectId).changes > 0;
}

/** Open (and how many of those are waiting) and departed counts per project. */
export function countsByProject(): Record<string, { open: number; waiting: number; gone: number }> {
  const out: Record<string, { open: number; waiting: number; gone: number }> = {};
  const rows = db
    .prepare(
      'SELECT project_id, state, status_category, COUNT(*) n FROM qa_items GROUP BY project_id, state, status_category',
    )
    .all() as Row[];
  for (const r of rows) {
    const c = (out[r.project_id] ??= { open: 0, waiting: 0, gone: 0 });
    if (r.state === 'gone') c.gone += r.n;
    else {
      c.open += r.n;
      if (r.status_category === '0') c.waiting += r.n;
    }
  }
  return out;
}

/* ── items ─────────────────────────────────────────────────── */

/** The stored document: the row part, plus what opening the post added. */
type Stored = RowItem & Partial<Detail> & {
  comments?: QaComment[];
  detailAt?: string | null;
  detailVersion?: string | null;
  triage?: QaTriage | null;
  triageError?: string | null;
  review?: QaReview | null;
};

function toItem(r: Row): QaItem {
  const doc = JSON.parse(r.data) as Stored;
  return {
    ...doc,
    body: doc.body ?? '',
    section: doc.section ?? null,
    images: doc.images ?? [],
    attachments: doc.attachments ?? [],
    hasVideo: doc.hasVideo ?? false,
    comments: doc.comments ?? [],
    detailAt: doc.detailAt ?? null,
    detailVersion: doc.detailVersion ?? null,
    triage: doc.triage ?? null,
    triageError: doc.triageError ?? null,
    review: doc.review ?? null,
    state: r.state,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
  };
}

/** The version stored for a post, or null when it has never been seen. */
export function storedVersion(postId: string): string | null {
  const row = db.prepare('SELECT version FROM qa_items WHERE post_id = ?').get(postId) as
    | Row
    | undefined;
  return row ? row.version : null;
}

/**
 * Insert a new item or replace a changed one from its list row.
 *
 * `first_seen_at` survives a replace, and so does what the last open read —
 * body, attachments, comments. They stay marked with the version they were
 * read at, which is how the console knows to read them again.
 */
export function save(item: RowItem, now: string): void {
  const previous = db.prepare('SELECT data FROM qa_items WHERE post_id = ?').get(item.postId) as
    | Row
    | undefined;
  const kept = previous ? (JSON.parse(previous.data) as Stored) : {};
  const data: Stored = { ...kept, ...item };
  db.prepare(
    `INSERT INTO qa_items
       (post_id, task_id, project_id, title, status_id, status_category, version, state, data,
        first_seen_at, updated_at, last_seen_at)
     VALUES (@postId, @taskId, @projectId, @title, @statusId, @statusCategory, @version, 'open', @data,
             @now, @now, @now)
     ON CONFLICT(post_id) DO UPDATE SET
       task_id = excluded.task_id, title = excluded.title, status_id = excluded.status_id,
       status_category = excluded.status_category,
       version = excluded.version, state = 'open', data = excluded.data,
       updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`,
  ).run({ ...item, data: JSON.stringify(data), now });
}

/** Attach what an open read — body, attachments, comments — to a stored item. */
export function saveDetail(
  postId: string,
  detail: Detail,
  comments: QaComment[],
  now: string,
): QaItem | null {
  const row = db.prepare('SELECT data, version FROM qa_items WHERE post_id = ?').get(postId) as
    | Row
    | undefined;
  if (!row) return null;
  const kept = JSON.parse(row.data) as Stored;
  const { title, ...rest } = detail;
  const data: Stored = {
    ...kept,
    ...rest,
    // The row's title is the task name; the post's own title wins when it has one.
    title: title || kept.title,
    comments,
    detailAt: now,
    detailVersion: row.version,
  };
  db.prepare('UPDATE qa_items SET data = ?, title = ? WHERE post_id = ?').run(
    JSON.stringify(data),
    data.title,
    postId,
  );
  return getItem(postId);
}

/** Seen again, unchanged. Also reopens an item that had dropped out and come back. */
export function touch(postId: string, now: string): void {
  db.prepare("UPDATE qa_items SET state = 'open', last_seen_at = ? WHERE post_id = ?").run(
    now,
    postId,
  );
}

/**
 * Close every open item of a project that the latest poll did not return.
 *
 * Only ever called after a poll that listed the project successfully: an API
 * outage must read as "nothing learned", not as "everything was taken".
 */
export function markGone(projectId: string, stillOpen: string[]): number {
  const open = db
    .prepare("SELECT post_id FROM qa_items WHERE project_id = ? AND state = 'open'")
    .all(projectId) as Row[];
  const gone = open.map((r) => r.post_id as string).filter((id) => !stillOpen.includes(id));
  const close = db.prepare("UPDATE qa_items SET state = 'gone' WHERE post_id = ?");
  for (const id of gone) close.run(id);
  return gone.length;
}

/**
 * Everything still waiting, plus the most recent of what has left.
 *
 * The limit applies to `gone` only. Open items are the point of the list, and
 * the one that has waited longest is the one a plain "latest N" would drop
 * first — its `updated_at` stops moving the day nobody touches it.
 */
/** Record a verdict, or the reason there is none. */
export function saveTriage(postId: string, triage: QaTriage | null, error: string | null): QaItem | null {
  const row = db.prepare('SELECT data FROM qa_items WHERE post_id = ?').get(postId) as Row | undefined;
  if (!row) return null;
  const kept = JSON.parse(row.data) as Stored;
  // A failed attempt keeps the previous verdict: stale beats blank.
  const data: Stored = { ...kept, triage: triage ?? kept.triage ?? null, triageError: error };
  db.prepare('UPDATE qa_items SET data = ? WHERE post_id = ?').run(JSON.stringify(data), postId);
  return getItem(postId);
}

/** Record, or clear, a person's lane. */
export function saveReview(postId: string, review: QaReview | null): QaItem | null {
  const row = db.prepare('SELECT data FROM qa_items WHERE post_id = ?').get(postId) as Row | undefined;
  if (!row) return null;
  const data: Stored = { ...(JSON.parse(row.data) as Stored), review };
  db.prepare('UPDATE qa_items SET data = ? WHERE post_id = ?').run(JSON.stringify(data), postId);
  return getItem(postId);
}

export function list(
  opts: { state?: QaItem['state']; projectId?: string; limit?: number } = {},
): QaItem[] {
  const scope = opts.projectId ? 'AND project_id = @projectId' : '';
  const params = { projectId: opts.projectId ?? '', limit: opts.limit ?? 100 };
  const open =
    opts.state === 'gone'
      ? []
      : db
          .prepare(`SELECT * FROM qa_items WHERE state = 'open' ${scope} ORDER BY updated_at DESC`)
          .all(params);
  const gone =
    opts.state === 'open'
      ? []
      : db
          .prepare(
            `SELECT * FROM qa_items WHERE state = 'gone' ${scope} ORDER BY updated_at DESC LIMIT @limit`,
          )
          .all(params);
  return ([...open, ...gone] as Row[]).map(toItem);
}

export function getItem(postId: string): QaItem | null {
  const row = db.prepare('SELECT * FROM qa_items WHERE post_id = ?').get(postId) as Row | undefined;
  return row ? toItem(row) : null;
}
