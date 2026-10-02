import { getConfig } from '../config.js';
import { request } from '../notify/transports/flow.js';
import type { QaComment, QaItem, QaProject, QaStatus } from '../types.js';

const cfg = getConfig();

/**
 * Read side of the QA project — three documented User API routes:
 *
 *   GET /user/posts/projects/{projectId}/tasks/filter   업무 필터 조회
 *   GET /user/posts/{postId}                            게시글 상세
 *   GET /user/comments/{postId}                         댓글 목록
 *
 * plus, per project and cached: `/user/projects/{projectId}/columns` for the
 * column names and `/user/projects/{projectId}/columns/status` for the status
 * options. Status option ids differ from project to project — Request is 5576
 * in one board and something else in the next — so nothing here hard-codes one.
 *
 * The three do not share a shape, and that is the thing to know before editing
 * this file. The filter route and the comments route answer in camelCase. The
 * post route answers in camelCase at the top and then hands back `tasks`,
 * `remarks` and the attachment lists as raw upper-snake database records
 * (`TASK_SRNO`, `WORKER_REC`, `SECTION_NAME`) — verified against the live API.
 * So everything that can be read from the filter route is read from there, and
 * the post route is asked only for what nothing else has: the body and the
 * attachments.
 */

interface Cell {
  customColumnData?: string;
  optionName?: string;
  optionCategory?: string;
  userName?: string;
}

interface Column {
  columnId?: string;
  columnType?: string;
  defaultColumnType?: string;
  columnData?: Cell[];
}

interface FilterPage {
  hasNext?: boolean;
  lastCursor?: number;
  tasks?: Array<{ taskId?: string; postId?: string; projectId?: string; columns?: Column[] }>;
}

/** One row of the filter route, reduced to what deciding "is this ours" takes. */
export interface Listed {
  taskId: string;
  postId: string;
  projectId: string;
  title: string;
  statusId: string;
  statusName: string;
  statusCategory: string;
  assignees: Array<{ id: string; name: string }>;
  registerName: string;
  registeredAt: string;
  editedAt: string;
  columns: Column[];
}

/** Never follow a cursor forever: a server that keeps saying hasNext would. */
const MAX_PAGES = 20;

function url(path: string, query: Record<string, string> = {}): string {
  const qs = new URLSearchParams(query).toString();
  return cfg.QA_API_BASE.replace(/\/+$/, '') + path + (qs ? `?${qs}` : '');
}

/**
 * The API allows 120 requests a minute per key, and a poll over a board of
 * eighty tasks asks for eighty comment threads. Calls are spaced so that a
 * whole poll stays under the limit, and a 429 that slips through anyway is
 * waited out once rather than reported as an unreadable post.
 */
const MIN_GAP_MS = 600; // ≈100/min
let nextSlot = 0;

async function paced(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function get<T>(path: string, query?: Record<string, string>): Promise<T> {
  await paced();
  let envelope;
  try {
    envelope = await request<T>(cfg.QA_API_KEY, 'GET', url(path, query));
  } catch (err) {
    if (!/\b429\b/.test(String(err))) throw err;
    // The window is a minute long; wait it out and go again, once. Everything
    // queued behind this call is pushed back the same way.
    nextSlot = Date.now() + 61_000;
    await paced();
    envelope = await request<T>(cfg.QA_API_KEY, 'GET', url(path, query));
  }
  // `request` lets a 2xx with no usable body through as an empty envelope —
  // fine for a write, fatal for a read: a maintenance page answering 200 would
  // become "the project has no waiting tasks", and the poller would close every
  // item it holds. No data is a failure here.
  if (envelope.data === undefined || envelope.data === null) {
    throw new Error(`qa GET ${path}: the response carried no data`);
  }
  return envelope.data;
}

function cells(columns: Column[], defaultType: string): Cell[] {
  return columns.find((c) => c.defaultColumnType === defaultType)?.columnData ?? [];
}

/**
 * Every task in the project assigned to the intake account, in any status.
 *
 * The assignee filter runs on the server — verified: `COLUMN_SRNO` of the
 * assignee column with `IN` and a user id answers only that user's tasks, which
 * turned 558 rows over six pages into 83 rows on one. The rows are checked
 * against the assignee list again afterwards all the same, so a server that
 * ignored the filter would hand back the project and still not have all of it
 * read as "ours".
 */
export async function listAssigned(project: QaProject): Promise<Listed[]> {
  const filterRecords = JSON.stringify([
    {
      COLUMN_SRNO: cfg.QA_WORKER_COLUMN_ID,
      OPERATOR_TYPE: 'IN',
      FILTER_DATA: cfg.QA_ASSIGNEE_IDS.join(','),
    },
  ]);

  const out: Listed[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (let page = 0; ; page++) {
    // Running out of pages is not the same as reaching the end. Returning what
    // was read so far would look like a complete list, and everything past it
    // would be closed as "no longer waiting".
    if (page >= MAX_PAGES) throw new Error(`qa: the task list did not end within ${MAX_PAGES} pages`);

    const data = await get<FilterPage>(
      `/user/posts/projects/${encodeURIComponent(project.projectId)}/tasks/filter`,
      { cursor: String(cursor), pageSize: '100', filterRecords },
    );
    if (!Array.isArray(data.tasks)) throw new Error('qa: the task list response has no `tasks`');

    for (const raw of data.tasks) {
      if (!raw.postId || !raw.taskId) continue;
      // Ids are strings today; normalised anyway, because they are compared
      // against what SQLite stored as text.
      const task = { ...raw, postId: String(raw.postId), taskId: String(raw.taskId) };
      // The store is keyed by post, so a post is read once even if the list
      // names it twice.
      if (seen.has(task.postId)) continue;
      seen.add(task.postId);
      const columns = task.columns ?? [];
      const status = cells(columns, 'STATUS')[0];
      const statusId = status?.customColumnData ?? '';
      const known = project.statuses.find((s) => s.id === statusId);

      out.push({
        taskId: task.taskId,
        postId: task.postId,
        projectId: String(task.projectId ?? project.projectId),
        title: cells(columns, 'TASK_NM')[0]?.customColumnData ?? '',
        statusId,
        statusName: status?.optionName ?? known?.name ?? '',
        statusCategory: status?.optionCategory ?? known?.category ?? '',
        assignees: cells(columns, 'WORKER_ID')
          .filter((c) => c.customColumnData)
          .map((c) => ({ id: c.customColumnData!, name: c.userName ?? '' })),
        registerName: cells(columns, 'RGSR_ID')[0]?.userName ?? '',
        registeredAt: cells(columns, 'RGSN_DTTM')[0]?.customColumnData ?? '',
        editedAt: cells(columns, 'EDTR_DTTM')[0]?.customColumnData ?? '',
        columns,
      });
    }

    const next = nextCursor(data, cursor);
    if (next === null) break;
    cursor = next;
  }
  return out;
}

/**
 * The cursor for the following page, or null at the end.
 *
 * A cursor that does not move forward counts as the end: a server repeating the
 * same one would otherwise have the same page fetched until the page cap.
 */
function nextCursor(data: { hasNext?: boolean; lastCursor?: number }, current: number): number | null {
  if (!data.hasNext || typeof data.lastCursor !== 'number') return null;
  return data.lastCursor > current ? data.lastCursor : null;
}

/** Whether a listed task sits with the intake account rather than a person. */
export function isOurs(task: Listed): boolean {
  const wanted = cfg.QA_ASSIGNEE_IDS.map((id) => id.toLowerCase());
  return task.assignees.some((a) => wanted.includes(a.id.toLowerCase()));
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic)(\?|$)/i;
const VIDEO = /\.(mp4|mov|webm|avi|mkv|m4v|wmv)$/i;

function isImageUrl(value: string): boolean {
  return /^https?:\/\//.test(value) && (IMAGE.test(value) || value.includes('/flowImg/'));
}

export async function fetchComments(postId: string): Promise<QaComment[]> {
  interface Page {
    hasNext?: boolean;
    lastCursor?: number;
    comments?: Array<{
      commentId?: string;
      contents?: string;
      registerId?: string;
      registerName?: string;
      registeredDateTime?: string;
      systemCode?: string | null;
      attachments?: Array<{ attachUrl?: string | null }>;
    }>;
  }

  const out: QaComment[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await get<Page>(`/user/comments/${encodeURIComponent(postId)}`, {
      cursor: String(cursor),
      size: '100',
    });
    for (const c of data.comments ?? []) {
      if (!c.commentId) continue;
      const id = String(c.commentId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        authorId: c.registerId ?? '',
        authorName: c.registerName ?? '',
        at: c.registeredDateTime ?? '',
        text: (c.contents ?? '').trim(),
        // A status or assignee change carries its arguments after `^^`
        // ("S45_2^^Request^^In Development"). A person's comment has either no
        // code or a bare one.
        system: (c.systemCode ?? '').includes('^^'),
        images: (c.attachments ?? [])
          .map((a) => a.attachUrl ?? '')
          .filter((u) => isImageUrl(u)),
      });
    }
    const next = nextCursor(data, cursor);
    if (next === null) break;
    cursor = next;
  }
  return out;
}

/**
 * What decides whether a post has to be read again.
 *
 * Built from the list row alone, so an unchanged post costs nothing beyond
 * the one list call per poll. A status move changes the status id and the
 * edit time; comments are deliberately not part of this — they are read when
 * somebody opens the post, not on every poll of every task.
 */
export function versionOf(task: Listed): string {
  // The leading number is the shape of the stored document. Bumping it makes
  // every post read again once, which is how a new field reaches rows that
  // would otherwise sit unchanged forever.
  return ['4', task.statusId, task.editedAt].join(':');
}

const columnNames = new Map<string, { at: number; names: Map<string, string> }>();

/** Column id → the name a person gave it. Custom columns are anonymous otherwise. */
async function names(projectId: string): Promise<Map<string, string>> {
  const cached = columnNames.get(projectId);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.names;
  const data = await get<{ columns?: Array<{ columnSrno?: string; columnName?: string }> }>(
    `/user/projects/${encodeURIComponent(projectId)}/columns`,
  );
  const map = new Map<string, string>();
  for (const c of data.columns ?? []) {
    if (c.columnSrno && c.columnName) map.set(c.columnSrno, c.columnName);
  }
  columnNames.set(projectId, { at: Date.now(), names: map });
  return map;
}

export interface ProjectInfo {
  projectId: string;
  title: string;
  statuses: QaStatus[];
}

/**
 * What a project calls its statuses.
 *
 * Also the validation step for adding a project: a board the key cannot see
 * answers with an error here rather than with an empty list later.
 */
export async function describeProject(projectId: string): Promise<ProjectInfo> {
  const status = await get<{
    columnSrno?: string;
    options?: Array<{ optionSrno?: string; optionName?: string; optionCategory?: string }>;
  }>(`/user/projects/${encodeURIComponent(projectId)}/columns/status`);
  const statuses = (status.options ?? [])
    .filter((o) => o.optionSrno)
    .map((o) => ({
      id: String(o.optionSrno),
      name: o.optionName ?? '',
      category: String(o.optionCategory ?? ''),
    }));
  if (!statuses.length) throw new Error(`qa: project ${projectId} has no status options`);

  // The project route answers with raw records; the title sits in the first
  // settings row. A project that cannot be read this way still polls fine, so
  // a missing title is not an error.
  let title = '';
  try {
    const data = await get<{ project?: { PROJECT_SETTING?: unknown } }>(
      `/user/projects/${encodeURIComponent(projectId)}`,
    );
    const setting = records(data.project?.PROJECT_SETTING)[0];
    if (setting) title = pick(setting, ['TTL', 'title', 'COLABO_TTL']);
  } catch {
    /* 제목 없이 진행 */
  }

  return { projectId, title, statuses };
}

/** Every project the key's owner takes part in — what the console offers to add. */
export async function participatingProjects(): Promise<
  Array<{ projectId: string; title: string; url: string }>
> {
  const data = await get<{
    projects?: Array<{ projectId?: string; title?: string; projectUrl?: string }>;
  }>('/user/projects/participants');
  return (data.projects ?? [])
    .filter((p) => p.projectId)
    .map((p) => ({ projectId: String(p.projectId), title: p.title ?? '', url: p.projectUrl ?? '' }));
}

/** The first string found under any of the given keys, whatever their case convention. */
function pick(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    : [];
}

interface RawPost {
  title?: string;
  content?: string;
  commentContent?: string;
  outContent?: string;
  contentJsonYn?: string;
  registerName?: string;
  registeredDateTime?: string;
  attachments?: unknown;
  imageAttachments?: unknown;
  tasks?: unknown;
}

/**
 * The body as text.
 *
 * `outContent` is the readable rendering and is preferred. `content` is only a
 * fallback, and only when it is not the editor's JSON document — pasting that
 * into a prompt later would bury the report under markup.
 */
function bodyOf(post: RawPost): string {
  for (const candidate of [post.outContent, post.commentContent]) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  const content = (post.content ?? '').trim();
  return post.contentJsonYn === 'Y' && /^[[{]/.test(content) ? '' : content;
}

/** What the list row alone gives — everything but the body, attachments and comments. */
export type RowItem = Omit<
  QaItem,
  | 'state' | 'firstSeenAt' | 'updatedAt' | 'lastSeenAt'
  | 'comments' | 'detailAt' | 'detailVersion' | 'triage' | 'triageError' | 'review'
  | 'body' | 'section' | 'images' | 'attachments' | 'hasVideo'
>;

/** What opening the post adds. */
export type Detail = Pick<QaItem, 'body' | 'section' | 'images' | 'attachments' | 'hasVideo'> & {
  title: string;
};

/**
 * An item from its list row, with no further call: the poll stores this.
 *
 * The column names are the one lookup, cached an hour per project. A project
 * whose columns cannot be read still has readable tasks; the values then
 * appear under the column id instead of its name, and the version is marked
 * so the row is stored again once the names are back.
 */
export async function fromRow(task: Listed): Promise<RowItem> {
  const columnName = await names(task.projectId).catch(() => null);

  const columns: Record<string, string[]> = {};
  for (const column of task.columns) {
    // Default columns (status, assignee, dates, number) are already fields of
    // their own. What is left is what the project added: Issue Type, Region…
    if (column.defaultColumnType || !column.columnId) continue;
    const values = (column.columnData ?? [])
      .map((c) => c.optionName || c.customColumnData || c.userName || '')
      .filter(Boolean);
    if (values.length) columns[columnName?.get(column.columnId) ?? `#${column.columnId}`] = values;
  }

  return {
    postId: task.postId,
    taskId: task.taskId,
    projectId: task.projectId,
    title: task.title,
    url:
      `${cfg.QA_WEB_BASE.replace(/\/+$/, '')}/main.act` +
      `?projectId=${encodeURIComponent(task.projectId)}&postId=${encodeURIComponent(task.postId)}`,
    statusId: task.statusId,
    statusName: task.statusName,
    statusCategory: task.statusCategory,
    assignees: task.assignees,
    columns,
    registerName: task.registerName,
    registeredAt: task.registeredAt,
    version: versionOf(task) + (columnName ? '' : ':unnamed'),
  };
}

/**
 * The post itself — read when somebody opens it.
 *
 * The attachment records are raw rows whose key names are not documented, so
 * images are recognised by what the value looks like rather than by which key
 * holds it: any http(s) URL that points at an image and is not a thumbnail.
 */
export async function fetchDetail(postId: string): Promise<Detail> {
  const post = await get<RawPost>(`/user/posts/${encodeURIComponent(postId)}`);

  const images: string[] = [];
  for (const record of records(post.imageAttachments)) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string' || !isImageUrl(value)) continue;
      if (/thum/i.test(key) || /_thumb\./i.test(value)) continue;
      if (!images.includes(value)) images.push(value);
    }
  }

  const attachments = records(post.attachments).map((record) => {
    const size = Number(pick(record, ['fileSize', 'FILE_SIZE', 'ATCH_FILE_SIZE']));
    return {
      name: pick(record, ['fileName', 'FILE_NM', 'ORCP_FILE_NM', 'ATCH_FILE_NM', 'FILE_NAME']),
      size: Number.isFinite(size) && size > 0 ? size : null,
    };
  });

  const section = records(post.tasks)[0];

  return {
    title: (post.title ?? '').trim(),
    body: bodyOf(post),
    section: section ? pick(section, ['SECTION_NAME', 'sectionName']) || null : null,
    images,
    attachments,
    hasVideo: attachments.some((a) => VIDEO.test(a.name)),
  };
}
