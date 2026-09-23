import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { redact } from '../util/redact.js';
import * as store from '../jobs/store.js';
import { renderText, progressOf } from './render.js';
import * as sse from './transports/sse.js';
import * as webhook from './transports/webhook.js';
import * as flow from './transports/flow.js';
import { TERMINAL_STATUSES } from '../types.js';
import type { EmitInput, FlowStatus, Job, JobEvent } from '../types.js';

const cfg = getConfig();

async function withRetry(
  label: string,
  jobId: string,
  seq: number,
  fn: () => Promise<void>,
): Promise<void> {
  const maxAttempts = 5;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      store.recordDelivery(jobId, seq, label, true, attempt, null);
      return;
    } catch (err) {
      lastError = String(err);
      if (attempt < maxAttempts) {
        // 400ms, 800ms, 1.6s, 3.2s — enough to ride out a restart, short
        // enough that the job never waits on the notifier.
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
    }
  }
  store.recordDelivery(jobId, seq, label, false, maxAttempts, lastError);
  logger.warn({ transport: label, jobId, seq, err: lastError }, 'delivery failed, giving up');
}

/**
 * The single path every progress signal takes: render → persist → fan out.
 * Transport failures are recorded but never propagate — a dead notifier must
 * not stop a job that is otherwise fine.
 */
export async function emit(job: Job, input: EmitInput): Promise<JobEvent> {
  const text = redact(renderText(job.locale, input));
  const event = store.appendEvent({
    jobId: job.id,
    stage: input.stage,
    status: input.status,
    progress: Number(progressOf(input.stage, input.status).toFixed(3)),
    locale: job.locale,
    text,
    data: redact(input.data ?? {}),
    ts: new Date().toISOString(),
  });

  logger.info({ jobId: job.id, stage: event.stage, seq: event.seq }, text);

  void sse.broadcast(event);

  const terminal = TERMINAL_STATUSES.includes(job.status) || input.status === 'failed';

  if (webhook.webhookEnabled(job.notify.url)) {
    void withRetry('webhook', job.id, event.seq, () => webhook.send(event, job.notify.url));
  }

  // A comment needs a thread, and the thread is created once, deliberately, in
  // the `registering` stage. Anything emitted before that — the queue
  // acknowledgement, triage starting — has nowhere to land yet and is carried
  // by the log and SSE alone. That is the point: the Flow task is not opened
  // until there is a summary worth putting in it.
  if (
    job.notify.kind === 'flow' &&
    job.flowPostId &&
    flow.flowEnabled() &&
    flow.shouldComment(event, terminal)
  ) {
    const postId = job.flowPostId;
    // `body` carries a whole document — a triage note, a root-cause report —
    // and the rendered one-liner is its heading rather than a second comment.
    const comment = input.body ? `${text}\n\n${redact(input.body)}` : text;
    void withRetry('flow', job.id, event.seq, () => flow.comment(postId, comment, job));
  }

  return event;
}

/**
 * Move the Flow task between columns, out of band of the event stream.
 *
 * Kept separate from `emit` because a status change is not a progress line: it
 * happens at three points only (registered → in progress → done or feedback),
 * and tying it to an event would move the card on every comment.
 */
export async function setFlowStatus(job: Job, status: FlowStatus): Promise<void> {
  if (job.notify.kind !== 'flow' || !job.flowTaskId || !flow.flowEnabled()) return;
  try {
    await flow.updateStatus(job, status);
    logger.info({ jobId: job.id, taskId: job.flowTaskId, status }, 'flow task status updated');
  } catch (err) {
    // A card left in the wrong column is worth a warning, never a failed job.
    logger.warn({ jobId: job.id, status, err: String(err) }, 'could not update the Flow task status');
  }
}

export function commentStages(): string[] {
  return cfg.FLOW_COMMENT_STAGES;
}
