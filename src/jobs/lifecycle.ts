import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { t } from '../i18n/index.js';
import { emit } from '../notify/bus.js';
import * as store from './store.js';
import { slugify } from '../util/ids.js';
import { runShell } from '../util/exec.js';
import {
  changedFiles,
  createBranch,
  createWorkspace,
  destroyWorkspace,
  diffStat,
} from '../workspace/worktree.js';
import { commitAll } from '../git/commit.js';
import { pushBranch } from '../git/push.js';
import { openOrUpdatePr } from '../forge/github.js';
import { runAgent } from '../agent/claude.js';
import { buildPrompt, commitMessage } from '../agent/prompt.js';
import type { Job, JobStatus, Stage } from '../types.js';
import type { Workspace } from '../workspace/worktree.js';

const cfg = getConfig();

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

class StageFailure extends Error {
  constructor(
    readonly stage: Stage,
    readonly reason: string,
    readonly status: JobStatus = 'failed',
  ) {
    super(reason);
    this.name = 'StageFailure';
  }
}

function branchName(job: Job): string {
  if (job.branch) return job.branch;
  const seed = job.context.alertname ?? job.instruction;
  const suffix = job.id.replace(/^job_/, '').slice(-3).toLowerCase();
  return `${cfg.BRANCH_PREFIX}/${slugify(seed)}-${suffix}`;
}

async function enter(job: Job, stage: Stage): Promise<void> {
  job.stage = stage;
  store.updateJob(job.id, { stage });
}

/**
 * The nine stages, in order. Every exit path — success, no-change, failure,
 * cancellation, timeout — emits exactly one final event and cleans up the
 * worktree, which is why the whole body sits inside one try/finally.
 */
export async function runJob(job: Job, signal: AbortSignal): Promise<void> {
  let ws: Workspace | null = null;
  const throwIfCancelled = () => {
    if (signal.aborted) throw new Cancelled();
  };

  store.updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
  job.status = 'running';

  try {
    // ── 2. preparing ──────────────────────────────────────────
    await enter(job, 'preparing');
    await emit(job, { stage: 'preparing', status: 'started', key: 'job.started', params: { repo: job.repo, base: job.base } });
    const t0 = Date.now();
    ws = await createWorkspace(job.id, job.repo, job.base);
    throwIfCancelled();
    await emit(job, {
      stage: 'preparing',
      status: 'done',
      key: 'job.workspace',
      params: { seconds: ((Date.now() - t0) / 1000).toFixed(1) },
    });

    // ── 3. branching ──────────────────────────────────────────
    await enter(job, 'branching');
    const branch = branchName(job);
    job.branch = branch;
    store.updateJob(job.id, { branch });
    await createBranch(ws, branch);
    throwIfCancelled();
    await emit(job, {
      stage: 'branching',
      status: 'done',
      key: 'job.branch',
      params: { branch, base: job.base },
      data: { branch },
    });

    // ── 4. planning ───────────────────────────────────────────
    await enter(job, 'planning');
    const { prompt, conventionFiles } = await buildPrompt(job, ws);
    throwIfCancelled();
    await emit(job, {
      stage: 'planning',
      status: 'done',
      key: 'job.context',
      params: { files: conventionFiles.length },
      data: { conventionFiles },
    });

    // ── 5. editing ────────────────────────────────────────────
    await enter(job, 'editing');
    await emit(job, { stage: 'editing', status: 'started', key: 'job.editing.started' });

    let lastToolEmit = 0;
    const agent = await runAgent({
      cwd: ws.dir,
      prompt,
      signal,
      onTool: (activity, state) => {
        // Every tool call would be noise; one line per second keeps the console
        // legible while still showing that work is happening.
        const now = Date.now();
        if (now - lastToolEmit < 1000) return;
        lastToolEmit = now;
        void emit(job, {
          stage: 'editing',
          status: 'running',
          key: 'job.editing.tool',
          params: { tool: activity.tool, target: activity.target },
          data: { files: state.filesTouched.size, turns: state.turns },
        });
      },
    });

    if (agent.timedOut) {
      throw new StageFailure(
        'editing',
        t(job.locale, 'job.timeout', {
          stage: 'editing',
          minutes: Math.round(cfg.AGENT_TIMEOUT_MS / 60000),
        }),
        'timed_out',
      );
    }
    throwIfCancelled();
    if (!agent.ok) {
      throw new StageFailure('editing', agent.stderr || agent.resultText || 'the agent reported an error');
    }

    const touched = await changedFiles(ws);
    store.updateJob(job.id, { filesChanged: touched.length });
    job.filesChanged = touched.length;
    await emit(job, {
      stage: 'editing',
      status: 'done',
      key: 'job.editing.done',
      params: { files: touched.length, turns: agent.turns },
      data: { files: touched.length, turns: agent.turns, changed: touched.slice(0, 40) },
    });

    // ── 6. verifying ──────────────────────────────────────────
    await enter(job, 'verifying');
    if (job.verify.length === 0) {
      await emit(job, { stage: 'verifying', status: 'done', key: 'job.verify.skipped' });
    } else {
      await runVerification(job, ws, signal, prompt);
    }
    throwIfCancelled();

    // ── 7. committing ─────────────────────────────────────────
    await enter(job, 'committing');
    const stat = await diffStat(ws);
    const commit = await commitAll(ws, commitMessage(job));
    if (!commit.committed) {
      await emit(job, { stage: 'committing', status: 'done', key: 'job.commit.nochanges' });
      await finish(job, 'no_changes', null);
      return;
    }
    await emit(job, {
      stage: 'committing',
      status: 'done',
      key: 'job.commit',
      params: { files: commit.files, author: commit.author },
      data: { sha: commit.sha, files: commit.files },
    });

    if (job.dryRun) {
      await emit(job, {
        stage: 'committing',
        status: 'done',
        key: 'job.dryrun',
        params: { files: commit.files },
        data: { diffStat: stat, dryRun: true },
      });
      await finish(job, 'succeeded', null);
      return;
    }

    // ── 8. pushing ────────────────────────────────────────────
    await enter(job, 'pushing');
    await pushBranch(ws, branch, job.base);
    throwIfCancelled();
    await emit(job, { stage: 'pushing', status: 'done', key: 'job.push', params: { branch } });

    // ── 9. pr_opened ──────────────────────────────────────────
    await enter(job, 'pr_opened');
    const pr = await openOrUpdatePr(job, branch, stat);
    store.updateJob(job.id, { prUrl: pr.url });
    job.prUrl = pr.url;
    await emit(job, {
      stage: 'pr_opened',
      status: 'done',
      key: pr.updated ? 'job.pr.updated' : 'job.pr.opened',
      params: { url: pr.url },
      data: { prUrl: pr.url, prNumber: pr.number },
    });

    await finish(job, 'succeeded', null);
  } catch (err) {
    if (err instanceof Cancelled || signal.aborted) {
      await emit(job, { stage: job.stage, status: 'failed', key: 'job.cancelled' });
      await finish(job, 'cancelled', 'cancelled');
      return;
    }
    const failure =
      err instanceof StageFailure
        ? err
        : new StageFailure(job.stage, err instanceof Error ? err.message : String(err));

    await emit(job, {
      stage: failure.stage,
      status: 'failed',
      key: 'job.failed',
      params: { stage: failure.stage, reason: failure.reason },
      data: { reason: failure.reason },
    });
    await finish(job, failure.status, failure.reason);
  } finally {
    if (ws) {
      // The stored row is authoritative here — `finish` may have run in a
      // branch the compiler cannot see from this scope.
      const outcome = store.getJob(job.id)?.status ?? 'failed';
      const keep = cfg.KEEP_WORKSPACE && outcome !== 'succeeded' && outcome !== 'no_changes';
      await destroyWorkspace(ws, keep).catch((err) =>
        logger.warn({ err: String(err), jobId: job.id }, 'workspace cleanup failed'),
      );
    }
  }
}

async function runVerification(
  job: Job,
  ws: Workspace,
  signal: AbortSignal,
  originalPrompt: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const failure = await runVerifyCommands(job, ws, signal);
    if (!failure) {
      await emit(job, {
        stage: 'verifying',
        status: 'done',
        key: 'job.verify.passed',
        params: { count: job.verify.length },
      });
      return;
    }

    if (attempt === 2) {
      throw new StageFailure('verifying', failure.text);
    }

    // One self-repair pass: the agent gets the failing output and nothing else.
    await emit(job, { stage: 'verifying', status: 'running', key: 'job.verify.retry' });
    const repair = await runAgent({
      cwd: ws.dir,
      signal,
      prompt: [
        originalPrompt,
        '',
        '## The verification step failed',
        `Command: ${failure.command}`,
        '',
        '```',
        failure.output.slice(-4000),
        '```',
        '',
        'Fix the cause of this failure. Do not disable, skip, or weaken the test.',
      ].join('\n'),
    });
    if (repair.timedOut || !repair.ok) {
      throw new StageFailure('verifying', failure.text);
    }
  }
}

async function runVerifyCommands(
  job: Job,
  ws: Workspace,
  signal: AbortSignal,
): Promise<{ command: string; output: string; text: string } | null> {
  for (const command of job.verify) {
    await emit(job, {
      stage: 'verifying',
      status: 'running',
      key: 'job.verify.running',
      params: { command },
    });
    const result = await runShell(command, {
      cwd: ws.dir,
      timeoutMs: cfg.VERIFY_TIMEOUT_MS,
      signal,
    });
    if (result.code !== 0) {
      return {
        command,
        output: `${result.stdout}\n${result.stderr}`,
        text: t(job.locale, 'job.verify.failed', { command, code: result.code }),
      };
    }
  }
  return null;
}

async function finish(job: Job, status: JobStatus, error: string | null): Promise<void> {
  job.status = status;
  store.updateJob(job.id, { status, error, finishedAt: new Date().toISOString() });
  logger.info({ jobId: job.id, status, prUrl: job.prUrl }, 'job finished');
}
