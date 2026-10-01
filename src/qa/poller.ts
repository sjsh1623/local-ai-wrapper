import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import * as client from './client.js';
import * as store from './store.js';
import * as triage from './triage.js';
import type { QaItem, QaProject } from '../types.js';

const cfg = getConfig();

export interface ProjectResult {
  waiting: number;
  ours: number;
  changed: number;
  gone: number;
  /** Posts that could not be read this time. */
  failed: number;
  /** Set when the project could not be listed at all; its items were left as they were. */
  error: string | null;
}

export interface PollerStatus {
  enabled: boolean;
  /** Why it is not polling, when it is not. */
  reason: string | null;
  intervalMs: number;
  /** A poll is in progress right now — the console shows it on the refresh button. */
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  /** Totals from the last completed poll, and the same per project. */
  last: Omit<ProjectResult, 'error'> | null;
  projects: Record<string, ProjectResult>;
}

const state: Pick<PollerStatus, 'lastRunAt' | 'lastError' | 'last' | 'projects'> = {
  lastRunAt: null,
  lastError: null,
  last: null,
  projects: {},
};

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
/** When each project's title and statuses were last looked up. */
const described = new Map<string, number>();
const describedAt = (id: string): number => described.get(id) ?? 0;


/**
 * What is missing, if anything.
 *
 * A half-configured poller does not take the server down with it — this is an
 * alert service first, and a missing QA key is no reason for it to stop taking
 * alerts. It says what it needs and stays off.
 */
function blockedBy(): string | null {
  if (!cfg.QA_ENABLED) return 'QA_ENABLED is off';
  if (!cfg.QA_API_KEY) return 'QA_API_KEY is empty';
  // Refusing beats the alternative: with no assignee to match, "ours" would
  // have to mean either nothing or the entire project.
  if (cfg.QA_ASSIGNEE_IDS.length === 0) return 'QA_ASSIGNEE_IDS is empty';
  return null;
}

/**
 * Never faster than once a minute. `inFlight` stops polls overlapping, not
 * following each other back to back, and a typo'd interval should not turn
 * this into a request loop against somebody else's API.
 */
function intervalMs(): number {
  return Math.max(60_000, cfg.QA_POLL_INTERVAL_MS);
}

export function status(): PollerStatus {
  const reason = blockedBy();
  return {
    enabled: reason === null,
    reason,
    intervalMs: intervalMs(),
    running: inFlight !== null,
    ...state,
  };
}

/**
 * Register a project, resolving what "waiting" means there.
 *
 * The statuses come from the project itself: whichever options sit in the
 * request family. A project the key cannot read fails here, before anything
 * is stored, so a typo in a project number is an error and not a silent
 * empty board.
 */
export async function addProject(projectId: string): Promise<QaProject> {
  const info = await client.describeProject(projectId);
  const project = store.saveProject(info, new Date().toISOString());
  described.set(projectId, Date.now());
  logger.info(
    { projectId, title: project.title, statuses: project.statuses.map((s) => s.name) },
    'qa: project added',
  );
  return project;
}

/**
 * The project named in the environment is the first one on the list, so a
 * deployment configured the old way keeps working.
 */
async function seedFromConfig(): Promise<void> {
  if (!cfg.QA_PROJECT_ID || store.getProject(cfg.QA_PROJECT_ID)) return;
  await addProject(cfg.QA_PROJECT_ID);
}

async function pollProject(project: QaProject, now: string): Promise<ProjectResult> {
  // Status names and the title are refreshed once an hour, in case the board
  // was renamed or given a new column. A failure here is not a reason to skip
  // the poll; the stored ones serve.
  if (Date.now() - describedAt(project.projectId) > 3_600_000) {
    try {
      project = store.saveProject(await client.describeProject(project.projectId), now);
      described.set(project.projectId, Date.now());
    } catch (err) {
      logger.warn({ projectId: project.projectId, err: String(err) }, 'qa: could not describe a project');
    }
  }

  const waiting = await client.listAssigned(project);
  const ours = waiting.filter(client.isOurs);

  let changed = 0;
  let failed = 0;
  const seen: string[] = [];
  // The list call is the whole poll: a row is stored from what it carries,
  // and nothing is read per post. The post itself and its comments are read
  // when somebody opens it — see `openPost`.
  for (const task of ours) {
    try {
      const stored = store.storedVersion(task.postId);
      if (stored === client.versionOf(task)) {
        store.touch(task.postId, now);
      } else {
        store.save(await client.fromRow(task), now);
        changed++;
        // A new or changed post that is waiting on a developer gets a verdict
        // without anyone asking — when that is switched on. A Re-request is a
        // changed post, so it comes back through here too.
        if (cfg.QA_TRIAGE_AUTO && task.statusCategory === '0') triage.enqueue(task.postId);
      }
      seen.push(task.postId);
    } catch (err) {
      // One unreadable post must not cost the rest of the poll. It stays in
      // `seen` so a transient failure does not close an item that is still there.
      seen.push(task.postId);
      failed++;
      logger.warn({ postId: task.postId, err: String(err) }, 'qa: could not read a post');
    }
  }

  const gone = store.markGone(project.projectId, seen);
  return { waiting: waiting.length, ours: ours.length, changed, gone, failed, error: null };
}

async function poll(): Promise<void> {
  const now = new Date().toISOString();
  await seedFromConfig();

  const totals = { waiting: 0, ours: 0, changed: 0, gone: 0, failed: 0 };
  const results: Record<string, ProjectResult> = {};
  for (const project of store.listProjects()) {
    try {
      const r = await pollProject(project, now);
      results[project.projectId] = r;
      for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += r[k];
    } catch (err) {
      // Listing failed: nothing learned about this project, so nothing closed.
      // The others still get their turn.
      results[project.projectId] = {
        waiting: 0, ours: 0, changed: 0, gone: 0, failed: 0, error: String(err),
      };
      logger.warn({ projectId: project.projectId, err: String(err) }, 'qa: could not list a project');
    }
  }

  state.last = totals;
  state.projects = results;
  const broken = Object.values(results).filter((r) => r.error).length;
  state.lastError = broken ? `${broken} project(s) could not be listed` : null;
  if (totals.changed > 0 || totals.gone > 0) logger.info({ ...totals }, 'qa: intake changed');
}

/**
 * Run one poll now. Overlapping calls share the run already in flight — the
 * interval and a manual refresh from the console can land at the same moment.
 */
export function pollNow(): Promise<void> {
  if (blockedBy() !== null) return Promise.resolve();
  inFlight ??= poll()
    .catch((err) => {
      state.lastError = String(err);
      logger.warn({ err: String(err) }, 'qa: poll failed');
    })
    .finally(() => {
      state.lastRunAt = new Date().toISOString();
      inFlight = null;
    });
  return inFlight;
}

/**
 * Read a post and its comments now — what opening it on the console triggers.
 *
 * Deliberately not part of the poll: a post is read when a person is about to
 * look at it, which is a handful of calls a day instead of one per task every
 * five minutes.
 */
export async function openPost(postId: string): Promise<QaItem | null> {
  if (!store.getItem(postId)) return null;
  const [detail, comments] = await Promise.all([
    client.fetchDetail(postId),
    client.fetchComments(postId),
  ]);
  return store.saveDetail(postId, detail, comments, new Date().toISOString());
}

export function start(): void {
  const reason = blockedBy();
  if (reason !== null) {
    if (cfg.QA_ENABLED) logger.warn({ reason }, 'qa: intake is enabled but cannot run');
    return;
  }
  logger.info({ intervalMs: intervalMs() }, 'qa: intake polling started');
  void pollNow();
  timer = setInterval(() => void pollNow(), intervalMs());
  timer.unref();
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
