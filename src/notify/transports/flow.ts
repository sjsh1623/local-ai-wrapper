import { getConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { t } from '../../i18n/index.js';
import type { Job, JobEvent } from '../../types.js';

const cfg = getConfig();

/**
 * Flow comment transport.
 *
 * The Flow API contract was not available when this was written, so every
 * request shape is driven by environment variables instead of being hard-coded.
 * Adapting to the real API should be a matter of editing `.env` — and if the
 * response shapes differ, only `postIdFrom()` and the two request bodies below
 * need changing.  See README → "Flow API".
 */

let disabledWarned = false;

export function flowEnabled(): boolean {
  if (!cfg.FLOW_API_BASE) {
    if (!disabledWarned) {
      disabledWarned = true;
      logger.warn(
        { transport: 'flow' },
        'FLOW_API_BASE is empty — Flow comments are disabled; progress still goes to webhook, SSE and the log',
      );
    }
    return false;
  }
  return true;
}

function url(pathTemplate: string, vars: Record<string, string>): string {
  const path = pathTemplate.replace(/\{(\w+)\}/g, (whole, k: string) =>
    k in vars ? encodeURIComponent(vars[k]!) : whole,
  );
  return cfg.FLOW_API_BASE.replace(/\/+$/, '') + path;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.FLOW_API_TOKEN) {
    h[cfg.FLOW_AUTH_HEADER.toLowerCase()] = cfg.FLOW_AUTH_SCHEME
      ? `${cfg.FLOW_AUTH_SCHEME} ${cfg.FLOW_API_TOKEN}`
      : cfg.FLOW_API_TOKEN;
  }
  return h;
}

async function call(method: string, target: string, body?: unknown): Promise<any> {
  const res = await fetch(target, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`flow ${method} ${res.status}: ${text.slice(0, 200)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Pull the post number out of whatever shape the API returned. */
function postIdFrom(payload: any): string | null {
  if (!payload) return null;
  const field = cfg.FLOW_POST_ID_FIELD;
  const pick = (o: any) => (o && o[field] != null ? String(o[field]) : null);

  if (Array.isArray(payload)) return payload.length ? pick(payload[0]) : null;
  const direct = pick(payload);
  if (direct) return direct;
  for (const key of ['data', 'result', 'post', 'items', 'list']) {
    const nested = payload[key];
    if (Array.isArray(nested)) return nested.length ? pick(nested[0]) : null;
    if (nested) {
      const found = pick(nested);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve the post this job comments on: an explicit id wins, then a lookup by
 * the alert fingerprint so a recurring alert keeps one thread, then creation.
 */
export async function resolvePost(job: Job): Promise<string | null> {
  if (!flowEnabled()) return null;
  if (job.notify.postId) return String(job.notify.postId);
  if (job.flowPostId) return job.flowPostId;

  const query = job.idempotencyKey ?? job.context.alertname ?? job.id;

  if (cfg.FLOW_POST_LOOKUP_PATH) {
    try {
      const found = postIdFrom(
        await call('GET', url(cfg.FLOW_POST_LOOKUP_PATH, { projectId: cfg.FLOW_PROJECT_ID, query })),
      );
      if (found) return found;
    } catch (err) {
      logger.warn({ err: String(err) }, 'flow post lookup failed, will create instead');
    }
  }

  const created = await call('POST', url(cfg.FLOW_POST_CREATE_PATH, {}), {
    projectId: cfg.FLOW_PROJECT_ID || undefined,
    title: t(job.locale, 'flow.title', {
      alertname: job.context.alertname ?? job.repo,
      repo: job.repo,
    }),
    body: t(job.locale, 'flow.opening', {
      alertname: job.context.alertname ?? '-',
      repo: job.repo,
      base: job.base,
      jobId: job.id,
    }),
    // Carried so a lookup can find this thread again on the next firing.
    externalKey: job.idempotencyKey ?? job.id,
  });

  return postIdFrom(created);
}

export async function comment(postId: string, text: string): Promise<void> {
  await call('POST', url(cfg.FLOW_COMMENT_PATH, { postId }), { body: text, content: text });
}

/** Which events earn a comment — the rest would drown the thread. */
export function shouldComment(event: JobEvent, terminal: boolean): boolean {
  const wanted = cfg.FLOW_COMMENT_STAGES;
  if (terminal && wanted.includes('final')) return true;
  if (event.status === 'failed') return true;
  if (!wanted.includes(event.stage)) return false;
  return event.status === 'done' || event.status === 'started';
}
