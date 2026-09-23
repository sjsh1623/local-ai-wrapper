import { z } from 'zod';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { matchRoute } from './routes.js';
import type { JobRequest, Locale } from '../types.js';

const cfg = getConfig();

/**
 * Alertmanager writes every label and annotation as a string, but a hand-rolled
 * curl or a future SigNoz release can put a number or a bool in there. Coercing
 * beats rejecting: the hook answers 200 on a parse failure so SigNoz stops
 * redelivering, which means a strict schema would make the alert disappear
 * rather than arrive imperfectly.
 */
const stringMap = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .transform((map) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(map ?? {})) {
      if (value === null || value === '') continue;
      out[key] = String(value);
    }
    return out;
  });

/**
 * SigNoz posts Prometheus Alertmanager v4 JSON and the body cannot be
 * templated, so this is the shape we have to accept as given. The only lever on
 * the sending side is what the alert rule puts in `labels` and `annotations`.
 */
export const alertSchema = z.object({
  status: z.string().optional(),
  labels: stringMap,
  annotations: stringMap,
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().optional(),
});

export const signozPayloadSchema = z.object({
  receiver: z.string().optional(),
  status: z.string().optional(),
  alerts: z.array(alertSchema).default([]),
  groupLabels: stringMap,
  commonLabels: stringMap,
  commonAnnotations: stringMap,
  externalURL: z.string().optional(),
  version: z.string().optional(),
  // Alertmanager's grouping key. Two batches carrying the same key are the same
  // group re-notified, which is worth recording even though we key idempotency
  // off the per-alert fingerprint.
  groupKey: z.string().optional(),
  truncatedAlerts: z.number().optional(),
});

export type SigNozAlert = z.infer<typeof alertSchema>;
export type SigNozPayload = z.infer<typeof signozPayloadSchema>;

export type Decision =
  | { action: 'job'; request: JobRequest; fingerprint: string }
  | { action: 'cancel'; fingerprint: string }
  | { action: 'skip'; reason: string; fingerprint: string };

/**
 * SigNoz fills the batch's `externalURL` with whatever address its own container
 * believes it has — observed on the wire as `http://localhost:8080`, which is a
 * dead link for everyone reading it here.
 */
function reachable(url?: string): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/.test(url) ? undefined : url;
}

/** Alertmanager sends this as `endsAt` while an alert is still firing. */
function realTime(value?: string): string | undefined {
  return !value || value.startsWith('0001-01-01') ? undefined : value;
}

/** Annotations consumed by name below; everything else is passed through as-is. */
const NAMED_ANNOTATIONS = new Set(['summary', 'description', 'info', 'value', 'threshold', 'unit']);

/**
 * How bad it is, in one line.
 *
 * `value` and `threshold` are SigNoz's `{{$value}}` / `{{$threshold}}` rendered
 * at notify time, and they are the only quantitative fact in the whole payload.
 * They used to be dropped, which left the agent reading "the failure rate is
 * over 5%" with no idea whether it was 5.1% or 40%.
 */
function measurement(annotations: Record<string, string>): string | null {
  const { value, threshold, unit } = annotations;
  if (!value) return null;
  const suffix = unit ? ` ${unit}` : '';
  return threshold
    ? `Measured ${value}${suffix} against a threshold of ${threshold}${suffix}.`
    : `Measured ${value}${suffix}.`;
}

function instructionFrom(alert: SigNozAlert): string {
  const a = alert.annotations;
  const parts: string[] = [];

  for (const key of ['summary', 'description', 'info']) {
    const text = a[key];
    if (text) parts.push(text);
  }

  const measured = measurement(a);
  if (measured) parts.push(measured);

  // Whatever the rule author added beyond the six keys above — a runbook, the
  // query expression, the evaluation window. Rules are free to invent keys, and
  // an annotation nobody here anticipated is exactly the one worth forwarding.
  const extra = Object.entries(a)
    .filter(([key]) => !NAMED_ANNOTATIONS.has(key))
    .map(([key, value]) => `- ${key}: ${value}`);
  if (extra.length) parts.push(`From the alert rule:\n${extra.join('\n')}`);

  if (parts.length === 0) {
    parts.push(`Alert ${a.alertname ?? alert.labels.alertname ?? 'unknown'} is firing.`);
  }
  return parts.join('\n\n');
}

function contextFrom(alert: SigNozAlert, payload: SigNozPayload): Record<string, string> {
  const ctx: Record<string, string> = { source: 'signoz' };

  const status = alert.status ?? payload.status;
  if (status) ctx.status = status;
  const startsAt = realTime(alert.startsAt);
  const endsAt = realTime(alert.endsAt);
  if (startsAt) ctx.startsAt = startsAt;
  if (endsAt) ctx.endsAt = endsAt;
  if (alert.fingerprint) ctx.fingerprint = alert.fingerprint;
  if (payload.receiver) ctx.receiver = payload.receiver;
  if (payload.groupKey) ctx.groupKey = payload.groupKey;

  // On the record rather than only inside the prose, so the console can show the
  // number without anyone unfolding the raw body.
  for (const key of ['value', 'threshold', 'unit']) {
    const value = alert.annotations[key];
    if (value) ctx[key] = value;
  }

  // Every label, not a chosen seven. The old whitelist silently dropped whatever
  // nobody had anticipated — `threshold.name` (which tier of an 85%/92% rule
  // actually fired), `host.name`, `mountpoint` — and those are usually the
  // labels that say which series is in trouble.
  for (const [key, value] of Object.entries(alert.labels)) {
    // The console, the commit trailer and routes.yml all read `service`;
    // SigNoz calls it `service.name`. Renamed rather than carried twice.
    ctx[key === 'service.name' ? 'service' : key] = value;
  }

  const alertUrl = alert.generatorURL || reachable(payload.externalURL) || cfg.SIGNOZ_URL;
  if (alertUrl) ctx.alertUrl = alertUrl;

  // The webhook exactly as it arrived. Without it the console can only show what
  // this function chose to keep, and "why did it decide that" becomes unanswerable
  // after the fact. Underscore-prefixed so `displayContext` keeps it out of the
  // agent prompt and the pull request body, where a JSON blob is just noise.
  ctx._raw = JSON.stringify(alert);
  return ctx;
}

/**
 * A connectivity probe wearing an incident's clothes.
 *
 * SigNoz's "send test notification" button posts a normal Alertmanager batch, so
 * without this it lands as a real defect report: the agent clones the repository
 * and burns a turn on nothing. With JOB_CONCURRENCY=1 it also parks the next real
 * alert behind it. Cheaper to name it than to run it.
 *
 * The two SigNoz markers are its literals, observed on the wire — alertname
 * "Test Alert (<channel>)" and that exact summary. `test=true` is for anyone
 * hand-rolling a payload with curl.
 */
function isTest(alert: SigNozAlert): boolean {
  if (alert.labels.test === 'true') return true;
  return (
    (alert.labels.alertname ?? '').startsWith('Test Alert') ||
    (alert.annotations.summary ?? '') === 'Test alert fired from SigNoz'
  );
}

/**
 * Decide what one alert means. The gate is deliberately closed by default: an
 * alert without an explicit opt-in — a label or a routes.yml entry — is skipped.
 */
export function decide(alert: SigNozAlert, payload: SigNozPayload): Decision {
  const labels = alert.labels;
  const fingerprint = alert.fingerprint ?? `${labels.alertname ?? 'alert'}:${alert.startsAt ?? ''}`;
  const status = alert.status ?? payload.status ?? 'firing';

  if (status === 'resolved') {
    return cfg.SIGNOZ_ON_RESOLVED === 'cancel'
      ? { action: 'cancel', fingerprint }
      : { action: 'skip', reason: 'resolved', fingerprint };
  }

  // Before the opt-in gate on purpose: a test must be named a test whether or not
  // it would have matched a route, otherwise the catch-all swallows the distinction.
  if (isTest(alert)) {
    return { action: 'skip', reason: 'test alert, not a real incident', fingerprint };
  }

  const route = matchRoute(labels);

  // An explicit "not this one" beats the opt-in label too. Otherwise a rule you
  // deliberately excluded here would come back the moment someone labels it.
  if (route?.skip) {
    return { action: 'skip', reason: 'routes.yml marks this alert as no-action', fingerprint };
  }

  const optedIn = labels[cfg.SIGNOZ_REQUIRE_LABEL] === 'true';
  if (!optedIn && !route) {
    return {
      action: 'skip',
      reason: `no ${cfg.SIGNOZ_REQUIRE_LABEL}=true label and no matching route`,
      fingerprint,
    };
  }

  // A multi-tier rule (85% warning / 92% critical) carries one static `severity`
  // label plus the tier that actually crossed. SigNoz names that label
  // `threshold.name` — with a dot, confirmed against alert history — so both
  // spellings are read rather than betting on one surviving a release.
  const severity = labels.severity ?? labels['threshold.name'] ?? labels.threshold_name;
  if (severity && !cfg.SIGNOZ_SEVERITIES.includes(severity)) {
    return { action: 'skip', reason: `severity ${severity} is not acted on`, fingerprint };
  }

  const repo = labels.repo ?? route?.repo;
  if (!repo) {
    return { action: 'skip', reason: 'no repo label and no matching route', fingerprint };
  }

  const locale = (labels.locale === 'en' || labels.locale === 'ko' ? labels.locale : cfg.LOCALE) as Locale;

  const request: JobRequest = {
    repo,
    base: labels.base ?? route?.base ?? cfg.DEFAULT_BASE_BRANCH,
    branch: labels.branch ?? null,
    instruction: instructionFrom(alert),
    context: contextFrom(alert, payload),
    verify: route?.verify ?? [],
    // A label wins over the route, as everywhere else here: `mcp: stripe,signoz`
    // on an alert rule overrides whatever routes.yml picked for it.
    mcp: labels.mcp
      ? labels.mcp.split(',').map((name) => name.trim()).filter(Boolean)
      : (route?.mcp ?? []),
    pr: {
      draft: route?.pr.draft ?? true,
      labels: route?.pr.labels ?? [],
      reviewers: route?.pr.reviewers ?? [],
      title: route?.pr.title,
    },
    notify: {
      kind: 'flow',
      // Label beats route beats FLOW_PROJECT_ID, the same precedence every
      // other field here uses.
      projectId: labels.flowProjectId ?? route?.flowProjectId ?? null,
      // Both ids or neither: commenting on an existing thread needs the post,
      // and moving its card needs the task. Half of the pair would silently
      // open a second task on the next firing.
      taskId: labels.flowTaskId ?? null,
      postId: labels.flowPostId ?? null,
      workers: route?.flowWorkers?.length ? route.flowWorkers : null,
      webhook: labels.flowWebhook ?? route?.flowWebhook ?? null,
    },
    locale,
    // Label wins per field, as everywhere else; the route only fills the gap. An
    // alert rule that says nothing about dryRun inherits its route's setting.
    dryRun: labels.dryRun !== undefined ? labels.dryRun === 'true' : (route?.dryRun ?? false),
    idempotencyKey: `signoz:${fingerprint}`,
  };

  return { action: 'job', request, fingerprint };
}

export function decideAll(payload: SigNozPayload): Decision[] {
  if (payload.truncatedAlerts) {
    // Say so rather than silently under-reporting what arrived.
    logger.warn(
      { truncatedAlerts: payload.truncatedAlerts },
      'SigNoz truncated this batch; some alerts in the group were not delivered',
    );
  }
  return payload.alerts.map((alert) => decide(alert, payload));
}
