import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { displayContext } from '../types.js';
import * as mcp from './mcp.js';
import type { Job } from '../types.js';
import type { Workspace } from '../workspace/worktree.js';

const cfg = getConfig();

const CONVENTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.github/CONTRIBUTING.md',
  'CONTRIBUTING.md',
  'README.md',
];

export interface PromptResult {
  prompt: string;
  conventionFiles: string[];
}

async function readIfPresent(dir: string, name: string): Promise<string | null> {
  try {
    const text = await readFile(join(dir, name), 'utf8');
    return text.slice(0, 8_000);
  } catch {
    return null;
  }
}

async function conventionsFor(ws: Workspace): Promise<{ files: string[]; blocks: string[] }> {
  const files: string[] = [];
  const blocks: string[] = [];
  for (const name of CONVENTION_FILES) {
    const text = await readIfPresent(ws.dir, name);
    if (text) {
      files.push(name);
      blocks.push(`### ${name}\n${text}`);
    }
    if (files.length >= 3) break;
  }
  return { files, blocks };
}

function contextBlock(job: Job): string {
  return displayContext(job.context)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
}

/**
 * The root-cause pass.
 *
 * This is the only stage that can reach the telemetry behind the alert. The
 * SigNoz MCP server is attached, the sandbox is read-only, and the deliverable
 * is a written explanation — the fix comes afterwards, in a separate run that
 * is handed this report.
 *
 * Splitting it that way is what makes the analysis reviewable: it is posted to
 * the Flow thread before a single line changes, so a person can disagree with
 * the diagnosis while the branch is still empty.
 */
export async function buildAnalysisPrompt(job: Job, ws: Workspace): Promise<PromptResult> {
  const { files, blocks } = await conventionsFor(ws);
  const context = contextBlock(job);
  const korean = job.locale === 'ko';

  const telemetry = cfg.SIGNOZ_MCP_URL
    ? [
        '## The telemetry is available to you',
        'A SigNoz MCP server is attached to this run. Use it. It is the difference',
        'between naming a cause and guessing one:',
        '',
        '- Search the logs and traces for the window the alert names (`startsAt`).',
        '- Filter on the resource attributes in the alert fields above —',
        '  `service.name` first, then whatever else the alert carried.',
        '- Read an exception or a slow trace end to end before concluding from it.',
        '- Timestamps are Unix milliseconds. Convert them; do not eyeball them.',
        '- One query per question. Do not re-run overlapping searches.',
        '- If a query returns nothing useful, say so in the report. An honest',
        '  "the telemetry does not show this" is a finding.',
        '',
      ].join('\n')
    : [
        '## No telemetry is attached',
        'SigNoz MCP is not configured for this run, so work from the alert fields',
        'and the source alone, and say plainly which parts you could not verify.',
        '',
      ].join('\n');

  // Named by the route, not inferred here: routes.yml is where "this alert is a
  // billing one" is already decided, and deciding it twice is how the two
  // answers drift apart.
  const stripe = job.mcp.includes('stripe') && mcp.configured('stripe')
    ? [
        '## Stripe is attached',
        'This is a billing alert, so a Stripe MCP server is attached as well. The',
        'money side of the failure is there and nowhere else:',
        '',
        '- Look up the charge, payment intent, invoice or subscription behind the',
        '  alert. Its status and its decline or failure code are the ground truth',
        '  for what actually happened to the payment.',
        '- Check whether our webhook handler received and acknowledged the event.',
        '  A charge that succeeded in Stripe and failed here is a different bug',
        '  from one Stripe declined, and they look identical from the logs.',
        '- Establish the blast radius: one customer, one card network, or everyone.',
        '',
        'Read only — never create, modify, refund or cancel anything in Stripe.',
        'Quote object ids in the report; never card numbers or raw customer PII.',
        '',
      ].join('\n')
    : '';

  const prompt = [
    'You are diagnosing a production alert against the repository checked out in',
    'the current working directory. Do not change any files — this pass produces a',
    'written diagnosis, and a different run will make the fix.',
    '',
    '## What fired',
    job.instruction.trim(),
    context ? `\n## Alert fields\n${context}` : '',
    '',
    telemetry,
    stripe,
    '## Then read the code',
    'Find the code path the telemetry points at. Name files and functions, and',
    'quote the few lines that matter. Prefer the cause over the symptom: a',
    'timeout is rarely the bug, it is where the bug surfaced.',
    '',
    blocks.length ? `## Repository conventions\n${blocks.join('\n\n')}\n` : '',
    '## What to write',
    // This report is posted to Flow verbatim, and Flow renders no markup at all.
    // Anything that would have been formatting arrives as literal punctuation, so
    // the report is plain text with `■` headings — see triage.ts, same contract.
    'Plain text — this is posted straight to Flow, which does not render Markdown.',
    'No `**bold**`, no `#` headings, no backticks, no code fences, no tables and no',
    '`---` rules; they arrive as literal characters. At most 45 lines, in exactly',
    'these sections, each heading on its own line:',
    '',
    '■ 어디서 — the service, the route or job, and the exact code path: name the',
    '  file and function, as path/to/file.ext:line. This is the section a reviewer',
    '  checks first, so it has to point at real lines you opened.',
    '■ 누가 / 무엇이 — what triggers the failing path. Which callers, which input,',
    '  which condition. If it only fails for some requests, say what distinguishes them.',
    '■ 왜 발생했나 — the mechanism, step by step, from the trigger to the symptom.',
    '  A missing null check, an unbounded retry, a lock held across an I/O call —',
    '  name it. "The service was slow" is a symptom, not a cause.',
    '■ 근거 — what in the telemetry and the source supports the above. Quote the',
    '  queries you ran, the exception, the trace ids, and the lines you read. Quote',
    '  code as indented lines, never in a fence.',
    '■ 영향 범위 — who and what is affected, and since when.',
    '■ 수정 방향 — the smallest change that addresses the cause, and exactly where.',
    '■ 확신도 — high / medium / low, and what evidence would raise it.',
    '',
    korean
      ? 'Write in Korean. Keep identifiers, file paths and metric names as they are.'
      : 'Write in English.',
    '',
    '## Rules',
    '- Do not edit, create, move or delete any file.',
    '- Do not invent trace ids, line numbers, metric values or commit hashes.',
    '- If you cannot establish the cause, say which hypothesis is most likely and',
    '  what evidence is missing. A truthful "not established" beats a confident guess.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { prompt, conventionFiles: files };
}

/**
 * The fix pass.
 *
 * The agent is told what broke, what the diagnosis was, where it is allowed to
 * work, and what "done" means — deliberately not how to fix it.
 */
export async function buildPrompt(
  job: Job,
  ws: Workspace,
  analysis?: string | null,
): Promise<PromptResult> {
  const { files, blocks } = await conventionsFor(ws);
  const context = contextBlock(job);

  const prompt = [
    'You are fixing a defect in this repository. Work only inside the current',
    'working directory.',
    '',
    '## What went wrong',
    job.instruction.trim(),
    context ? `\n## Where this came from\n${context}` : '',
    // The analysis is the previous stage's own output, already shared with the
    // reviewers on the Flow thread. Carrying it here is what makes the fix
    // answer the diagnosis people have seen rather than a fresh reading.
    analysis
      ? `\n## Root-cause analysis from the previous pass\n${analysis.trim()}\n\nTreat this as a strong lead, not as proven. If the source contradicts it, follow the source and say so.`
      : '',
    blocks.length ? `\n## Repository conventions\n${blocks.join('\n\n')}` : '',
    '',
    '## What to do',
    '1. Find the code responsible. Read before you edit.',
    '2. Make the smallest change that actually fixes the cause, not the symptom.',
    '3. Follow the conventions above — match the surrounding code.',
    '4. Update or add a test when the repository has tests for that area.',
    '',
    '## What not to do',
    '- Do not commit, branch, push, or open a pull request. That is handled for you.',
    '- Do not reformat, rename, or refactor code unrelated to this fix.',
    '- Do not edit files outside this working directory.',
    '',
    'When the change is complete, briefly state which files you changed and why.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { prompt, conventionFiles: files };
}

export function commitMessage(job: Job): string {
  const subject = job.context.alertname
    ? `fix: ${job.context.alertname}`
    : `fix: ${job.instruction.trim().split('\n')[0]?.slice(0, 60)}`;
  const trailers = [
    '',
    job.context.alertUrl ? `Alert: ${job.context.alertUrl}` : '',
    job.flowUrl ? `Flow: ${job.flowUrl}` : '',
    `Morningmate-Alert-Job: ${job.id}`,
  ].filter(Boolean);
  return [subject, ...trailers].join('\n');
}
