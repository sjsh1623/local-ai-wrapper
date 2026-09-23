import { Octokit } from '@octokit/rest';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { displayContext } from '../types.js';
import type { Job } from '../types.js';

const cfg = getConfig();

const octokit = new Octokit({ auth: cfg.GITHUB_TOKEN, baseUrl: cfg.GITHUB_API_URL });

export interface PullRequest {
  url: string;
  number: number;
  updated: boolean;
}

function bodyFor(job: Job, diffStat: string): string {
  const lines: string[] = [];
  lines.push(job.instruction.trim(), '');

  const context = displayContext(job.context);
  if (context.length) {
    lines.push('---', '');
    for (const [k, v] of context) {
      lines.push(`- **${k}**: ${v}`);
    }
    lines.push('');
  }

  if (diffStat) {
    lines.push('```', diffStat, '```', '');
  }

  lines.push(
    `<sub>Opened by morningmate-alert · job \`${job.id}\`` +
      (job.context.alertUrl ? ` · [alert](${job.context.alertUrl})` : '') +
      '</sub>',
  );
  return lines.join('\n');
}

export async function openOrUpdatePr(
  job: Job,
  branch: string,
  diffStat: string,
): Promise<PullRequest> {
  const [owner, repo] = job.repo.split('/') as [string, string];
  const title =
    job.pr.title ??
    `${job.context.alertname ? `${job.context.alertname}: ` : ''}${firstLine(job.instruction)}`;
  const body = bodyFor(job, diffStat);

  const existing = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: 'open',
  });

  if (existing.data.length > 0) {
    const pr = existing.data[0]!;
    await octokit.pulls.update({ owner, repo, pull_number: pr.number, title, body });
    return { url: pr.html_url, number: pr.number, updated: true };
  }

  const created = await octokit.pulls.create({
    owner,
    repo,
    head: branch,
    base: job.base,
    title,
    body,
    draft: job.pr.draft,
  });

  if (job.pr.labels.length) {
    await octokit.issues
      .addLabels({ owner, repo, issue_number: created.data.number, labels: job.pr.labels })
      .catch((err) => logger.warn({ err: String(err) }, 'could not add labels'));
  }
  if (job.pr.reviewers.length) {
    await octokit.pulls
      .requestReviewers({
        owner,
        repo,
        pull_number: created.data.number,
        reviewers: job.pr.reviewers,
      })
      .catch((err) => logger.warn({ err: String(err) }, 'could not request reviewers'));
  }

  return { url: created.data.html_url, number: created.data.number, updated: false };
}

export async function checkToken(): Promise<string> {
  const { data } = await octokit.rest.users.getAuthenticated();
  return data.login;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 68 ? `${line.slice(0, 65)}...` : line;
}
