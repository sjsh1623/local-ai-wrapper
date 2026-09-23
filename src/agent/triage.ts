import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { displayContext } from '../types.js';
import { runAgent } from './index.js';
import * as mcp from './mcp.js';
import type { Job } from '../types.js';

const cfg = getConfig();

export interface Triage {
  /** The plain text that gets registered as the Flow task body. */
  summary: string;
  /** True when a model wrote it; false when the deterministic fallback did. */
  fromAgent: boolean;
}

/**
 * The one paragraph a person actually wants.
 *
 * An Alertmanager batch is written for a rules engine: a summary annotation, a
 * rendered `{{$value}}`, a dozen labels, and a fingerprint. Registered verbatim
 * it produces a Flow task nobody reads. This pass hands that body to the agent
 * and asks for the note a person on call would have written — what fired, how
 * bad, what it probably means, what to look at.
 *
 * Three properties are deliberate:
 *
 *  - It is read-only and gets no repository. There is no worktree yet at this
 *    point in the lifecycle, and the task is to paraphrase an alert, not to
 *    investigate one — that is the `analyzing` stage's job.
 *  - It has its own short timeout. The Flow board shows nothing until this
 *    returns, so a slow model here is a visible delay to a person waiting.
 *  - It never fails the job. Every error path falls back to `plainSummary`,
 *    which is the pre-existing behaviour: the alert's own text, unedited.
 */
export async function triage(job: Job, signal?: AbortSignal): Promise<Triage> {
  if (!cfg.TRIAGE_ENABLED) return { summary: plainSummary(job), fromAgent: false };

  // Outside any repository on purpose: the agent has nothing to read here but
  // the prompt, and an empty directory is the clearest way to say so.
  const scratch = await mkdtemp(join(tmpdir(), 'morningmate-alert-triage-'));
  try {
    const run = await runAgent({
      cwd: scratch,
      prompt: triagePrompt(job),
      signal,
      readOnly: true,
      timeoutMs: cfg.TRIAGE_TIMEOUT_MS,
      // Triage is on a person's clock — the Flow board shows nothing until it
      // returns — so SigNoz is opt-in here. The route's own servers are not:
      // `stripe` was named because that alert cannot be described without it.
      mcp: [...(cfg.TRIAGE_USE_SIGNOZ_MCP ? ['signoz'] : []), ...job.mcp],
      // The scratch directory is not a repository, which Codex refuses by default.
      allowUntrackedCwd: true,
    });

    const text = (run.resultText ?? '').trim();
    if (!run.ok || run.timedOut || text.length < 20) {
      // stderr is included deliberately: this pass fails fast and quietly, and
      // without the agent's own message a configuration problem is
      // indistinguishable from a model that had nothing to say.
      logger.warn(
        {
          jobId: job.id,
          ok: run.ok,
          timedOut: run.timedOut,
          chars: text.length,
          stderr: run.stderr.slice(-500),
        },
        'triage produced nothing usable; registering the alert text as-is',
      );
      return { summary: plainSummary(job), fromAgent: false };
    }
    return { summary: text, fromAgent: true };
  } catch (err) {
    logger.warn({ jobId: job.id, err: String(err) }, 'triage failed; registering the alert text as-is');
    return { summary: plainSummary(job), fromAgent: false };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

function triagePrompt(job: Job): string {
  const facts = displayContext(job.context)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const korean = job.locale === 'ko';

  // With SigNoz attached this pass can answer "where" and "who" from the actual
  // exception, rather than restating the alert. Without it, the honest answer to
  // both is usually "the alert does not say", and the prompt has to make that
  // the expected outcome instead of an invitation to guess.
  const stripe = job.mcp.includes('stripe') && mcp.configured('stripe')
    ? [
        '## Stripe is attached',
        'This alert is about billing, so a Stripe MCP server is attached alongside',
        'the telemetry. The failing charge, subscription or webhook delivery is in',
        'Stripe, not in the traces — look it up rather than describing the alert:',
        '',
        '- The charge, payment intent or invoice the alert points at: its status,',
        '  its decline or failure code, and the message Stripe returned.',
        '- Whether Stripe retried, and whether the webhook delivery to us succeeded.',
        '- Whether this is one customer or many. That is the difference between a',
        '  declined card and an outage, and the alert alone cannot tell them apart.',
        '',
        'Read only. Never create, modify, refund or cancel anything in Stripe.',
        'Do not put card numbers, full customer emails or raw PII in the note — an',
        'object id is what a reader needs to find it again.',
        '',
      ].join('\n')
    : '';

  const telemetry = cfg.TRIAGE_USE_SIGNOZ_MCP && cfg.SIGNOZ_MCP_URL
    ? [
        '## Look it up before you write',
        'A SigNoz MCP server is attached. Spend a few queries on it — the whole',
        'point of this note is that a reader should not have to. Aim for:',
        '',
        '- The failing requests themselves: filter on the `service` above and the',
        '  window around `startsAt`. Pull one real example end to end.',
        '- The exception or error log behind them: its type, its message, and the',
        '  top application frame in the stack. That frame is the "which code" answer.',
        '- The route, operation or job name that failed, and how many distinct',
        '  callers or users are affected versus the total.',
        '',
        'Timestamps are Unix milliseconds — convert them, do not eyeball them.',
        'One query per question; do not re-run overlapping searches. Four or five',
        'queries is the budget, not twenty. If a query comes back empty, that is',
        'an answer too: write that the telemetry does not show it.',
        '',
      ].join('\n')
    : [
        '## No telemetry is attached',
        'You have the alert and nothing else, so several sections below will have',
        'no answer. Say so plainly rather than filling them in from imagination.',
        '',
      ].join('\n');

  return [
    'You are the on-call engineer opening an incident ticket. Someone who was not',
    'paged will read this first and needs to understand, without opening a',
    'dashboard: where it broke, who it hit, what actually failed, and why.',
    '',
    '## Alert text',
    job.instruction.trim(),
    '',
    '## Alert fields',
    facts || '(none)',
    '',
    `## Target repository\n${job.repo} (base branch ${job.base})`,
    '',
    telemetry,
    stripe,
    '## What to write',
    // Flow renders neither Markdown nor HTML: a `**heading**` arrives as literal
    // asterisks and a fenced block as a row of backticks. The note is written as
    // plain text for that reason, with `■` standing in for a heading.
    'Plain text. Flow does not render Markdown, so use no `**bold**`, no `#`',
    'headings, no backticks, no code fences, no tables and no `---` rules — any of',
    'those show up as literal characters. At most 20 lines. Use exactly these five',
    'headings, each on its own line, in this order:',
    '',
    '■ 어디서 — service, environment and host; the route, endpoint or job that',
    '  failed; and when it started. Be specific: POST /v1/payments beats "the API".',
    '■ 누가 / 무엇이 — what set it off. A user request, a scheduled job, a',
    '  webhook from an upstream, a deploy. How many callers or requests are',
    '  affected against the total, if the telemetry says.',
    '■ 무엇이 발생했나 — the symptom in one or two sentences, with the measured',
    '  value against its threshold. Name the exception type and message if there is one.',
    '■ 왜 발생했나 — the mechanism, not the symptom. What in the system produced',
    '  this. Name the component or code path you believe is responsible and say how',
    '  sure you are.',
    '■ 확인할 것 — two or three concrete next checks.',
    '',
    'Write the body under each heading as ordinary sentences, or as lines starting',
    'with "- " where a list genuinely helps. File paths, identifiers and values go',
    'in bare, with no quoting characters around them.',
    '',
    korean
      ? 'Write in Korean. Keep service names, routes, exception types, metric names'
        + ' and identifiers in their original form — do not translate them.'
      : 'Write in English.',
    '',
    '## Rules',
    '- Every fact must come from the alert above or from a query you actually ran.',
    '  Do not invent numbers, trace ids, stack frames, commits, user names or dashboards.',
    '- Where you could not establish something, write "확인되지 않음" and, if it',
    '  matters, what would establish it. A short honest note beats a full invented one.',
    '- Separate what you measured from what you infer. Hedge the inference, not the measurement.',
    '- No preamble, no sign-off, no restating this instruction. Output the note only.',
  ].join('\n');
}

/**
 * What gets registered when the agent is off, slow, or unusable.
 *
 * This is the alert exactly as it arrived, which is what the Flow task used to
 * carry before triage existed — a worse ticket, never a missing one.
 */
export function plainSummary(job: Job): string {
  return job.instruction.trim();
}
