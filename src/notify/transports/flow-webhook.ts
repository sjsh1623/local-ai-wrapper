import { getConfig } from '../../config.js';
import { logger } from '../../logger.js';
import type { Job } from '../../types.js';

const cfg = getConfig();

/**
 * Flow incoming webhooks — https://api.flow.team/docs → 웹훅.
 *
 * A Flow webhook endpoint is created in the admin portal against a fixed bot,
 * a fixed Action (채팅 / 글 / 업무 / 일정) and a fixed Target (project or chat
 * room). Posting to it creates one item of that kind. The custom `/service`
 * shape takes `{ title, text }` and authenticates with the
 * `x-flow-webhook-token` header.
 *
 * What that buys, and what it does not:
 *
 *  - 업무 등록 works. The endpoint's own Action decides whether the result is a
 *    task, a post or a chat message; nothing here can influence that.
 *  - **Status changes are impossible.** Moving a task to 진행 needs its taskId,
 *    and the webhook response is `{"response":{"success":true,"code":200,
 *    "message":"success"}}` — verified on the wire, no id of any kind.
 *  - **Real comments are impossible** for the same reason. Every POST creates a
 *    *new* item in the target, so an update cannot attach to the task it is
 *    about. Follow-ups are therefore posted as separate items whose title
 *    carries the alert name and job id, which is what makes them findable.
 *
 * Both gaps close the moment a `FLOW_API_KEY` exists — see flow.ts, which
 * prefers the User API whenever one is configured.
 */

export interface WebhookTarget {
  name: string;
  url: string;
  token: string;
}

/** Flow answers 429 above 60 requests per minute per endpoint. */
const RATE_LIMIT_PER_MINUTE = 60;

export function targets(): Record<string, WebhookTarget> {
  return cfg.flowWebhooks;
}

export function webhookEnabled(): boolean {
  return Object.keys(cfg.flowWebhooks).length > 0;
}

/**
 * Which endpoint this job posts to: the alert's own, then the route's, then
 * `default`. This is what replaces the relay's `team` fan-out — billing alerts
 * keep their own room because a route names `billing` here.
 */
export function targetFor(job: Job): WebhookTarget | null {
  const wanted = job.notify.webhook ?? 'default';
  const known = cfg.flowWebhooks;
  const target = known[wanted] ?? known.default ?? null;
  if (!target && wanted !== 'default') {
    logger.warn(
      { jobId: job.id, wanted, known: Object.keys(known) },
      'no Flow webhook by that name and no default; this job will not reach Flow',
    );
  }
  return target;
}

export async function post(target: WebhookTarget, title: string, text: string): Promise<void> {
  // The documented ceiling for a post body is 10,000 characters. Truncating
  // beats being rejected: a shortened root-cause report is still worth reading.
  const body = {
    title: title.length > 200 ? `${title.slice(0, 197)}...` : title,
    text: text.length > 9_800 ? `${text.slice(0, 9_800)}\n\n…(생략됨)` : text,
  };

  const res = await fetch(target.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-flow-webhook-token': target.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const raw = await res.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (res.status === 429) {
    throw new Error(
      `flow webhook ${target.name} rate limited (${RATE_LIMIT_PER_MINUTE}/min); the notifier will retry`,
    );
  }

  // Flow nests its envelope one level down here — `{"response":{...}}` — and
  // that envelope, not the HTTP status, is what says whether the item was made.
  const envelope = payload?.response ?? payload;
  if (!res.ok || envelope?.success === false) {
    const detail = envelope?.error?.message ?? envelope?.message ?? raw.slice(0, 300);
    throw new Error(`flow webhook ${target.name} ${res.status}: ${detail}`);
  }

  const remaining = res.headers.get('x-ratelimit-remaining');
  logger.debug({ target: target.name, remaining }, 'flow webhook delivered');
}
