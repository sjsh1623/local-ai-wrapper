import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job } from '../types.js';
import type { Workspace } from '../workspace/worktree.js';

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

/**
 * The agent is told what broke, where it is allowed to work, and what "done"
 * means — deliberately not how to fix it.
 */
export async function buildPrompt(job: Job, ws: Workspace): Promise<PromptResult> {
  const conventionFiles: string[] = [];
  const conventions: string[] = [];

  for (const name of CONVENTION_FILES) {
    const text = await readIfPresent(ws.dir, name);
    if (text) {
      conventionFiles.push(name);
      conventions.push(`### ${name}\n${text}`);
    }
    if (conventionFiles.length >= 3) break;
  }

  const context = Object.entries(job.context)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const prompt = [
    'You are fixing a defect in this repository. Work only inside the current',
    'working directory.',
    '',
    '## What went wrong',
    job.instruction.trim(),
    context ? `\n## Where this came from\n${context}` : '',
    conventions.length ? `\n## Repository conventions\n${conventions.join('\n\n')}` : '',
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

  return { prompt, conventionFiles };
}

export function commitMessage(job: Job): string {
  const subject = job.context.alertname
    ? `fix: ${job.context.alertname}`
    : `fix: ${job.instruction.trim().split('\n')[0]?.slice(0, 60)}`;
  const trailers = [
    '',
    job.context.alertUrl ? `Alert: ${job.context.alertUrl}` : '',
    `Branchsmith-Job: ${job.id}`,
  ].filter(Boolean);
  return [subject, ...trailers].join('\n');
}
