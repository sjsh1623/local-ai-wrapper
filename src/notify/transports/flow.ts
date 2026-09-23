import { getConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { t } from '../../i18n/index.js';
import { displayContext } from '../../types.js';
import * as hook from './flow-webhook.js';
import type { FlowStatus, Job, JobEvent } from '../../types.js';

const cfg = getConfig();

/**
 * Flow transport.
 *
 * There are two ways into Flow and this module picks between them:
 *
 *  - **The User API**, when `FLOW_API_KEY` and `FLOW_PROJECT_ID` are set. Full
 *    fidelity: register a task, move it between columns, comment on its thread.
 *  - **An incoming webhook**, otherwise. Needs no admin key, and can only
 *    create items — see flow-webhook.ts for exactly what that costs.
 *
 * The API is preferred wherever it is available, because the pipeline it was
 * built for — register, move to 진행, comment the diagnosis, comment the PR —
 * only exists in full there.
 *
 * The rest of this file is the User API client, written against the documented
 * routes:
 *
 *   https://api.flow.team/docs → API 엔드포인트 → User → Posts / Comments
 *
 * Three calls carry the whole integration:
 *
 *   POST   /user/posts/projects/{projectId}/tasks                     업무 등록
 *   PATCH  /user/posts/projects/{projectId}/tasks/{taskId}/status     업무 상태 수정
 *   POST   /user/comments/{postId}                                    댓글 작성
 *
 * Two things about that contract are easy to get wrong and expensive to debug:
 *
 *  - Authentication is the `x-flow-api-key` header. Not a bearer token.
 *  - `createTask` hands back BOTH a `taskId` and a `postId`, and they are not
 *    interchangeable. Status changes address the task; comments address the
 *    post. Passing a taskId to the comment route 404s in a way that reads like
 *    a permission problem.
 *
 * The User API resolves the author from the key, so unlike the `/v1` variants
 * of the same routes no `registerId` is sent.
 */

/** Flow's envelope: `success` is authoritative, not the HTTP status alone. */
interface FlowEnvelope<T = any> {
  success?: boolean;
  code?: number;
  message?: string;
  data?: T;
  error?: { code?: string; message?: string };
}

export interface FlowTask {
  projectId: string;
  postId: string;
  taskId: string;
  url: string | null;
}

let disabledWarned = false;

/** Whether the REST path is available at all. */
export function apiEnabled(): boolean {
  if (!cfg.FLOW_API_KEY || !cfg.FLOW_PROJECT_ID) return false;
  // A v1 key files the task as somebody, and there is no somebody in the key.
  return cfg.FLOW_API_SURFACE !== 'v1' || Boolean(cfg.FLOW_REGISTER_ID);
}

/**
 * Whether real thread comments are possible.
 *
 * Only the personal surface has a comments endpoint — `/v1/comments/{postId}`
 * and `/v1/posts/{postId}/comments` both 404, verified against the live API. On
 * v1 the task and its status are real, and every update falls back to a
 * separate webhook item.
 */
export function canComment(): boolean {
  return apiEnabled() && cfg.FLOW_API_SURFACE === 'user';
}

/**
 * Flow needs either an API key with a project, or at least one webhook
 * endpoint. Having neither is a supported configuration — the pipeline still
 * runs end to end and reports through the log, SSE and the generic webhook —
 * so this warns once instead of throwing.
 */
export function flowEnabled(): boolean {
  if (apiEnabled() || hook.webhookEnabled()) return true;
  if (!disabledWarned) {
    disabledWarned = true;
    logger.warn(
      { transport: 'flow' },
      'no FLOW_API_KEY + FLOW_PROJECT_ID and no FLOW_WEBHOOK_URL — Flow is disabled; progress still goes to webhook, SSE and the log',
    );
  }
  return false;
}

/** What /readyz and the logs call the path in use. */
export function mode(): 'api' | 'v1+webhook' | 'webhook' | 'disabled' {
  if (canComment()) return 'api';
  // Tasks and status changes over REST, updates over the webhook.
  if (apiEnabled()) return hook.webhookEnabled() ? 'v1+webhook' : 'webhook';
  return hook.webhookEnabled() ? 'webhook' : 'disabled';
}

/**
 * Marks a job as living on a webhook rather than on a real post.
 *
 * `emit` gates comments on `flowPostId` being set, and in webhook mode there is
 * no post id to set — so this sentinel stands in for one and tells `comment()`
 * which endpoint to post the follow-up to.
 */
const WEBHOOK_POST_PREFIX = 'webhook:';

/** Where this job's task lives: the alert's own project, else the default. */
export function projectFor(job: Job): string {
  return job.flowProjectId || job.notify.projectId || cfg.FLOW_PROJECT_ID;
}

function url(pathTemplate: string, vars: Record<string, string>): string {
  const path = pathTemplate.replace(/\{(\w+)\}/g, (whole, k: string) =>
    k in vars ? encodeURIComponent(vars[k]!) : whole,
  );
  return cfg.FLOW_API_BASE.replace(/\/+$/, '') + path;
}

async function call<T>(method: string, target: string, body?: unknown): Promise<FlowEnvelope<T>> {
  const res = await fetch(target, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-flow-api-key': cfg.FLOW_API_KEY,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Flow occasionally takes its time on task creation; a hung fetch would
    // otherwise hold a notifier retry slot open indefinitely.
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let payload: FlowEnvelope<T> | null = null;
  try {
    const parsed = text ? JSON.parse(text) : null;
    // Every Flow response — REST and webhook, success and failure — is wrapped
    // in a `response` object. The documentation's examples show that wrapper
    // and it is easy to read past: unwrapped, a perfectly successful task
    // creation looks like a response that carried no ids.
    payload = (parsed?.response ?? parsed) as FlowEnvelope<T> | null;
  } catch {
    payload = null;
  }

  // `success: false` arrives with a 200 in some deployments, so the flag is
  // checked as well as the status code — otherwise a rejected call looks like
  // a delivered one and the thread silently stops updating.
  if (!res.ok || payload?.success === false) {
    const detail =
      payload?.error?.message ?? payload?.message ?? text.slice(0, 300) ?? `HTTP ${res.status}`;
    const code = payload?.error?.code ? ` ${payload.error.code}` : '';
    throw new Error(`flow ${method} ${res.status}${code}: ${detail}`);
  }
  return payload ?? {};
}

/**
 * Register the task.
 *
 * `contents` is the triage summary Codex wrote, so what lands on the board is a
 * readable incident note rather than an Alertmanager payload. The alert's own
 * facts are appended underneath, because the summary is a model's paraphrase
 * and the numbers behind it should stay checkable.
 */
export async function createTask(job: Job, summary: string): Promise<FlowTask> {
  if (!apiEnabled()) return createViaWebhook(job, summary);

  const projectId = projectFor(job);
  if (!projectId) throw new Error('no Flow project id for this job');

  const workers = (job.notify.workers ?? cfg.FLOW_WORKERS).filter(Boolean);

  const body: Record<string, unknown> = {
    title: taskTitle(job),
    contents: taskBody(job, summary),
    status: cfg.FLOW_STATUS_NEW,
    priority: cfg.FLOW_TASK_PRIORITY,
  };
  // The personal surface takes the author from the key; the admin one has no
  // user attached to the key and rejects the call without this.
  if (cfg.FLOW_API_SURFACE === 'v1') body.registerId = cfg.FLOW_REGISTER_ID;
  if (workers.length) body.workers = workers.map((workerId) => ({ workerId }));

  const created = await call<{
    projectId?: string;
    postId?: string;
    taskId?: string;
    tinyUrl?: string;
  }>('POST', url(cfg.flowTaskCreatePath, { projectId }), body);

  const data = created.data ?? {};
  if (!data.taskId || !data.postId) {
    throw new Error(`flow task created but the response carried no taskId/postId: ${JSON.stringify(created).slice(0, 300)}`);
  }

  // The post id is only useful if something can comment on it. On v1 nothing
  // can, so the sentinel is handed back instead and updates route to the
  // webhook — the task itself, and its status, stay real either way.
  const commentTarget = canComment()
    ? String(data.postId)
    : webhookSentinel(job);

  return {
    projectId: data.projectId ?? projectId,
    postId: commentTarget,
    taskId: String(data.taskId),
    url: data.tinyUrl ?? null,
  };
}

/** The `webhook:<name>` stand-in for a post id. Null when no endpoint fits. */
function webhookSentinel(job: Job): string {
  const target = hook.targetFor(job);
  return target ? `${WEBHOOK_POST_PREFIX}${target.name}` : '';
}

/**
 * Register through an incoming webhook.
 *
 * The endpoint's configured Action decides what actually gets made — task,
 * post or chat message — and no id comes back, so the returned `taskId` is the
 * job's own. Nothing addresses Flow by it; it exists so the console and the
 * commit trailer have something to show.
 */
async function createViaWebhook(job: Job, summary: string): Promise<FlowTask> {
  const target = hook.targetFor(job);
  if (!target) throw new Error('no Flow webhook endpoint for this job');

  await hook.post(target, taskTitle(job), taskBody(job, summary));

  return {
    projectId: target.name,
    postId: `${WEBHOOK_POST_PREFIX}${target.name}`,
    taskId: job.id,
    url: null,
  };
}

/**
 * Move the task between columns.
 *
 * Flow rejects a change to the status a task is already in ("동일한 업무 상태로
 * 변경할 수 없습니다"), which is a normal outcome here — a job that fails during
 * `registering` never left `request`. That case is logged, not raised.
 */
export async function updateStatus(job: Job, status: FlowStatus): Promise<void> {
  // A webhook cannot move anything: it has no id for the item it created. This
  // is the one part of the intended pipeline that an incoming webhook simply
  // cannot do, and it is silent by design — a warning per status change on
  // every job would say the same thing forever. `/readyz` reports the mode.
  // Both REST surfaces can, so this only bites in webhook-only mode.
  if (!apiEnabled()) {
    logger.debug(
      { jobId: job.id, status },
      'flow is in webhook mode; task status cannot be changed without FLOW_API_KEY',
    );
    return;
  }

  const projectId = projectFor(job);
  if (!projectId || !job.flowTaskId) return;
  try {
    const body: Record<string, unknown> = { status };
    // v1 wants the author on the status change too, not only on creation.
    // Omitted, it answers 400 "작성자ID 은(는) 필수 값입니다" — and the task then
    // sits in 요청 for the whole run while the agent is plainly working on it.
    if (cfg.FLOW_API_SURFACE === 'v1') body.registerId = cfg.FLOW_REGISTER_ID;
    await call('PATCH', url(cfg.flowTaskStatusPath, { projectId, taskId: job.flowTaskId }), body);
  } catch (err) {
    const message = String(err);
    if (message.includes('동일한 업무 상태')) {
      logger.debug({ jobId: job.id, status }, 'flow task was already in this status');
      return;
    }
    throw err;
  }
}

export async function comment(postId: string, text: string, job?: Job): Promise<void> {
  // In webhook mode there is no thread to comment on, so the update is posted
  // as its own item. The title carries the alert and the job id, which is the
  // only thing that lets a reader tie it back to the task it belongs to.
  if (postId.startsWith(WEBHOOK_POST_PREFIX)) {
    const name = postId.slice(WEBHOOK_POST_PREFIX.length);
    const target = hook.targets()[name] ?? (job ? hook.targetFor(job) : null);
    if (!target) throw new Error(`no Flow webhook endpoint named ${name}`);
    const heading = job
      ? `${t(job.locale, 'flow.title', { alertname: job.context.alertname ?? job.repo, repo: job.repo })} · ${job.id}`
      : 'morningmate-alert';
    await hook.post(target, heading, text);
    return;
  }

  // The documented ceiling is 10,000 characters. A truncated comment is worth
  // more than a rejected one, so a long root-cause report is cut here.
  const contents = text.length > 9_800 ? `${text.slice(0, 9_800)}\n\n…(생략됨)` : text;
  await call('POST', url(cfg.FLOW_COMMENT_PATH, { postId }), { contents });
}

/** A divider that survives a renderer that renders nothing — `---` would not. */
const SEPARATOR = '\u2500'.repeat(24);

function taskTitle(job: Job): string {
  const title = t(job.locale, 'flow.title', {
    alertname: job.context.alertname ?? job.repo,
    repo: job.repo,
  });
  // Flow caps the title at 200 characters and rejects anything longer.
  return title.length > 200 ? `${title.slice(0, 197)}...` : title;
}

/**
 * The task body.
 *
 * Everything here is plain text on purpose. Flow renders neither Markdown nor
 * HTML in a task body or a comment, so a `---` rule arrives as three dashes and
 * a `**heading**` as a pair of asterisks around a word. The triage and analysis
 * prompts are written to the same contract; this only has to avoid undoing it.
 */
function taskBody(job: Job, summary: string): string {
  const facts = displayContext(job.context)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const body = [
    summary.trim(),
    '',
    SEPARATOR,
    t(job.locale, 'flow.opening', {
      alertname: job.context.alertname ?? '-',
      repo: job.repo,
      base: job.base,
      jobId: job.id,
    }),
    facts ? `\n${facts}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return body.length > 9_800 ? `${body.slice(0, 9_800)}\n\n…(생략됨)` : body;
}

/** Which events earn a comment — the rest would drown the thread. */
export function shouldComment(event: JobEvent, terminal: boolean): boolean {
  const wanted = cfg.FLOW_COMMENT_STAGES;
  if (terminal && wanted.includes('final')) return true;
  if (event.status === 'failed') return true;
  if (!wanted.includes(event.stage)) return false;
  if (event.status === 'done') return true;
  // A "starting…" line is a cheap extra message inside a thread and a whole
  // extra post in the project when there is no thread to put it in. Webhook
  // mode therefore reports outcomes only.
  return event.status === 'started' && apiEnabled();
}
