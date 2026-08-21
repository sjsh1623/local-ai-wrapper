import { z } from 'zod';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { matchRoute } from './routes.js';
import type { JobRequest, Locale } from '../types.js';

const cfg = getConfig();

/**
 * SigNoz posts Prometheus Alertmanager v4 JSON and the body cannot be
 * templated, so this is the shape we have to accept as given.
 */
export const alertSchema = z.object({
  status: z.string().optional(),
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().optional(),
});

export const signozPayloadSchema = z.object({
  receiver: z.string().optional(),
  status: z.string().optional(),
  alerts: z.array(alertSchema).default([]),
  groupLabels: z.record(z.string()).optional(),
  commonLabels: z.record(z.string()).optional(),
  commonAnnotations: z.record(z.string()).optional(),
  externalURL: z.string().optional(),
  version: z.string().optional(),
  truncatedAlerts: z.number().optional(),
});

export type SigNozAlert = z.infer<typeof alertSchema>;
export type SigNozPayload = z.infer<typeof signozPayloadSchema>;

export type Decision =
  | { action: 'job'; request: JobRequest; fingerprint: string }
  | { action: 'cancel'; fingerprint: string }
  | { action: 'skip'; reason: string; fingerprint: string };

function instructionFrom(alert: SigNozAlert): string {
  const a = alert.annotations;
  const parts = [a.summary, a.description, a.info].filter(Boolean) as string[];
  if (parts.length === 0) {
    parts.push(`Alert ${alert.labels.alertname ?? 'unknown'} is firing.`);
  }
  return parts.join('\n\n');
}

function contextFrom(alert: SigNozAlert, externalURL?: string): Record<string, string> {
  const ctx: Record<string, string> = { source: 'signoz' };
  const carry = ['alertname', 'severity', 'service.name', 'deployment.environment'];
  for (const key of carry) {
    const value = alert.labels[key];
    if (value) ctx[key === 'service.name' ? 'service' : key] = value;
  }
  if (alert.generatorURL) ctx.alertUrl = alert.generatorURL;
  else if (externalURL) ctx.alertUrl = externalURL;
  if (alert.startsAt) ctx.startsAt = alert.startsAt;
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

  const severity = labels.severity;
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
    context: contextFrom(alert, payload.externalURL),
    verify: route?.verify ?? [],
    pr: {
      draft: route?.pr.draft ?? true,
      labels: route?.pr.labels ?? [],
      reviewers: route?.pr.reviewers ?? [],
      title: route?.pr.title,
    },
    notify: { kind: 'flow', postId: labels.flowPostId ?? null },
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
