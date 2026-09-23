import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { t } from '../i18n/index.js';
import { emit, setFlowStatus } from '../notify/bus.js';
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
import { agentLabel, runAgent } from '../agent/index.js';
import { buildAnalysisPrompt, buildPrompt, commitMessage } from '../agent/prompt.js';
import { triage } from '../agent/triage.js';
import * as flow from '../notify/transports/flow.js';
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
 * The eleven stages, in order. Every exit path — success, no-change, failure,
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
    // ── 2. triaging ───────────────────────────────────────────
    // Codex turns the Alertmanager body into the note that gets registered.
    // Deliberately before anything is cloned: this is the text a person reads
    // first, and nothing downstream should have to wait on a git fetch for it.
    await enter(job, 'triaging');
    await emit(job, { stage: 'triaging', status: 'started', key: 'job.triage.started', params: { agent: agentLabel() } });
    const summary = await triage(job, signal);
    throwIfCancelled();
    job.summary = summary.summary;
    store.updateJob(job.id, { summary: summary.summary });
    await emit(job, {
      stage: 'triaging',
      status: 'done',
      key: summary.fromAgent ? 'job.triage.done' : 'job.triage.fallback',
      data: { fromAgent: summary.fromAgent },
    });

    // ── 3. registering ────────────────────────────────────────
    // The Flow task is opened with that summary, then moved straight to "in
    // progress" — the run really is starting, and a card sitting in 요청 while
    // an agent edits code misreports what is happening.
    await enter(job, 'registering');
    await registerInFlow(job, summary.summary);
    throwIfCancelled();

    // ── 4. preparing ──────────────────────────────────────────
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

    // ── 5. branching ──────────────────────────────────────────
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

    // ── 6. analyzing ──────────────────────────────────────────
    // The only stage that can reach SigNoz. It is read-only and its output is
    // posted to the Flow thread before any file changes, so the diagnosis is
    // reviewable while the branch is still empty.
    const analysis = await runAnalysis(job, ws, signal);
    throwIfCancelled();

    // ── 7. editing ────────────────────────────────────────────
    const { prompt, conventionFiles } = await buildPrompt(job, ws, analysis);
    logger.debug({ jobId: job.id, conventionFiles }, 'fix prompt built');
    await enter(job, 'editing');
    await emit(job, {
      stage: 'editing',
      status: 'started',
      key: 'job.editing.started',
      params: { agent: agentLabel() },
    });

    let lastToolEmit = 0;
    const agent = await runAgent({
      cwd: ws.dir,
      prompt,
      signal,
      // The fix pass sees what the diagnosis saw. It usually works from the
      // analysis it was handed, but a fix that needs one more lookup should not
      // have to guess — and on a billing alert that lookup is in Stripe.
      mcp: ['signoz', ...job.mcp],
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
    // The agent's own account of what it changed and why. It is the only
    // description of the fix written by whoever made it, so it goes in the PR
    // comment rather than being thrown away with the rest of the stream.
    const editSummary = (agent.resultText ?? '').trim();
    await emit(job, {
      stage: 'editing',
      status: 'done',
      key: 'job.editing.done',
      params: { files: touched.length, turns: agent.turns },
      data: { files: touched.length, turns: agent.turns, changed: touched.slice(0, 40) },
    });

    // ── 8. verifying ──────────────────────────────────────────
    await enter(job, 'verifying');
    if (job.verify.length === 0) {
      await emit(job, { stage: 'verifying', status: 'done', key: 'job.verify.skipped' });
    } else {
      await runVerification(job, ws, signal, prompt);
    }
    throwIfCancelled();

    // ── 9. committing ─────────────────────────────────────────
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

    // ── 10. pushing ───────────────────────────────────────────
    await enter(job, 'pushing');
    await pushBranch(ws, branch, job.base);
    throwIfCancelled();
    await emit(job, { stage: 'pushing', status: 'done', key: 'job.push', params: { branch } });

    // ── 11. pr_opened ─────────────────────────────────────────
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
      // Not just the link. Whoever reads the Flow task wants to close it, and
      // to do that they need "this was the cause, this is what changed, here is
      // the diff" in one place — not a URL they have to go and interpret.
      body: prComment(job, pr.url, pr.number, editSummary, touched, stat),
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

/**
 * The heading marker for everything posted to Flow.
 *
 * Flow renders no markup, so `###` arrives as three hashes. This is what stands
 * in for a heading here and in the triage and analysis prompts — one marker, so
 * a reader sees the same shape in the task body and in every comment under it.
 */
const HEADING = '\u25a0';

/**
 * The comment that closes the loop on the Flow task.
 *
 * The thread already carries the alert (the task body) and the diagnosis (the
 * analysis comment). What was missing was the third part a reader needs before
 * they can act: what was actually changed, and where to review it. The cause is
 * repeated in one line on purpose — by the time this lands the analysis comment
 * has scrolled, and a fix with no stated reason is not reviewable.
 */
function prComment(
  job: Job,
  url: string,
  number: number,
  editSummary: string,
  touched: string[],
  diffStat: string,
): string {
  const ko = job.locale === 'ko';
  const lines: string[] = [];

  // One line of cause, pulled from the analysis's own 요약/summary section.
  const cause = firstSection(job.analysis);
  if (cause) lines.push(ko ? `${HEADING} 원인\n${cause}` : `${HEADING} Cause\n${cause}`, '');

  if (editSummary) {
    lines.push(ko ? `${HEADING} 수정 내용` : `${HEADING} What changed`, editSummary, '');
  }

  if (touched.length) {
    const shown = touched.slice(0, 20).map((f) => `- ${f}`);
    if (touched.length > 20) shown.push(ko ? `- …외 ${touched.length - 20}개` : `- …and ${touched.length - 20} more`);
    lines.push(
      ko ? `${HEADING} 변경 파일 (${touched.length}개)` : `${HEADING} Files (${touched.length})`,
      ...shown,
      '',
    );
  }

  // The diff stat used to be fenced. A fence is two visible rows of backticks in
  // Flow and nothing else, so the stat is indented instead — which is what a
  // fence was there to do in the first place.
  if (diffStat.trim()) {
    lines.push(
      ko ? `${HEADING} 변경량` : `${HEADING} Diffstat`,
      ...diffStat.trim().split('\n').map((line) => `  ${line}`),
      '',
    );
  }

  lines.push(`${HEADING} Pull Request\n#${number} — ${url}`);
  return lines.join('\n');
}

/**
 * The first section of the analysis report — its 요약 / summary paragraph.
 *
 * The report is plain text with `■ heading` sections; this takes the text under
 * the first one and stops at the second, so the PR comment restates the cause
 * without reproducing the whole diagnosis underneath it.
 *
 * The old `**heading**` form is still accepted. A report is written by a model
 * against a prompt, and a model that reaches for bold anyway should not cost the
 * comment its cause line.
 */
function firstSection(analysis: string | null): string | null {
  if (!analysis) return null;
  const body = analysis.replace(/^\s+/, '');
  const afterFirstHeading = body.replace(
    new RegExp(`^(?:${HEADING}[^\n]*|\\*\\*[^*]+\\*\\*)\\s*`),
    '',
  );
  const upToNext =
    afterFirstHeading.split(new RegExp(`\n\\s*(?:${HEADING}|\\*\\*[^*]+\\*\\*)`))[0] ?? '';
  const text = upToNext.trim();
  if (!text) return null;
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

async function finish(job: Job, status: JobStatus, error: string | null): Promise<void> {
  job.status = status;
  store.updateJob(job.id, { status, error, finishedAt: new Date().toISOString() });
  logger.info({ jobId: job.id, status, prUrl: job.prUrl }, 'job finished');

  // `no_changes` counts as done: the run reached a considered conclusion that
  // there was nothing to change, and leaving that card in 진행 forever would
  // make the board lie. Anything else needs a person, so it goes to 피드백.
  const settled = status === 'succeeded' || status === 'no_changes';
  await setFlowStatus(job, settled ? cfg.FLOW_STATUS_DONE : cfg.FLOW_STATUS_FAILED);
}

/**
 * Open the Flow task and move it to "in progress".
 *
 * Both halves are best-effort. Flow being unreachable is a reporting outage,
 * not a reason to abandon a fix that is otherwise about to happen — the run
 * continues and every later comment is simply skipped, because `flowPostId`
 * stays null and `emit` has nowhere to post.
 */
async function registerInFlow(job: Job, summary: string): Promise<void> {
  if (job.notify.kind !== 'flow' || !flow.flowEnabled()) {
    await emit(job, { stage: 'registering', status: 'done', key: 'job.flow.disabled' });
    return;
  }

  // An alert that names an existing task comments on it instead of opening a
  // second one — this is how a re-fired alert keeps a single thread.
  if (job.notify.taskId && job.notify.postId) {
    job.flowTaskId = job.notify.taskId;
    job.flowPostId = job.notify.postId;
    job.flowProjectId = flow.projectFor(job);
    store.updateJob(job.id, {
      flowTaskId: job.flowTaskId,
      flowPostId: job.flowPostId,
      flowProjectId: job.flowProjectId,
    });
    await emit(job, {
      stage: 'registering',
      status: 'done',
      key: 'job.flow.reused',
      params: { taskId: job.flowTaskId },
      data: { taskId: job.flowTaskId, postId: job.flowPostId },
      body: summary,
    });
  } else {
    try {
      const task = await flow.createTask(job, summary);
      job.flowProjectId = task.projectId;
      job.flowTaskId = task.taskId;
      job.flowPostId = task.postId;
      job.flowUrl = task.url;
      store.updateJob(job.id, {
        flowProjectId: task.projectId,
        flowTaskId: task.taskId,
        flowPostId: task.postId,
        flowUrl: task.url,
      });
      // Webhook mode gets its own line. Saying "moved it to in progress" there
      // would be a plain untruth: the endpoint returns no task id, so there is
      // nothing to move, and `setFlowStatus` below is a no-op.
      const viaApi = flow.apiEnabled();
      await emit(job, {
        stage: 'registering',
        status: 'done',
        key: viaApi ? 'job.flow.registered' : 'job.flow.registered.webhook',
        params: viaApi
          ? { taskId: task.taskId, url: task.url ?? '-' }
          : { target: task.projectId },
        data: { taskId: task.taskId, postId: task.postId, flowUrl: task.url, mode: flow.mode() },
      });
    } catch (err) {
      logger.warn({ jobId: job.id, err: String(err) }, 'could not register the Flow task');
      await emit(job, {
        stage: 'registering',
        status: 'failed',
        key: 'job.flow.failed',
        params: { reason: String(err) },
        data: { reason: String(err) },
      });
      return;
    }
  }

  await setFlowStatus(job, cfg.FLOW_STATUS_RUNNING);
}

/**
 * The root-cause pass: read-only, SigNoz MCP attached, output shared before any
 * code changes.
 *
 * Returns null when the analysis is off, fails or times out — the fix stage
 * then runs exactly as it did before this stage existed. Diagnosing is a
 * help, not a precondition, and a SigNoz outage must not stop a repair.
 */
async function runAnalysis(
  job: Job,
  ws: Workspace,
  signal: AbortSignal,
): Promise<string | null> {
  await enter(job, 'analyzing');

  if (!cfg.ANALYSIS_ENABLED) {
    await emit(job, { stage: 'analyzing', status: 'done', key: 'job.analysis.skipped' });
    return null;
  }

  await emit(job, {
    stage: 'analyzing',
    status: 'started',
    key: 'job.analysis.started',
    params: { agent: agentLabel(), source: cfg.SIGNOZ_MCP_URL ? 'SigNoz MCP' : 'repository only' },
  });

  const { prompt } = await buildAnalysisPrompt(job, ws);

  let lastToolEmit = 0;
  const run = await runAgent({
    cwd: ws.dir,
    prompt,
    signal,
    readOnly: true,
    timeoutMs: cfg.ANALYSIS_TIMEOUT_MS,
    // SigNoz always, plus whatever this alert's route added — `stripe` on a
    // billing alert. This is the pass that has to name a cause, so it gets
    // every source the route thought was relevant.
    mcp: ['signoz', ...job.mcp],
    onTool: (activity, state) => {
      const now = Date.now();
      if (now - lastToolEmit < 1000) return;
      lastToolEmit = now;
      void emit(job, {
        stage: 'analyzing',
        status: 'running',
        key: 'job.analysis.tool',
        params: { tool: activity.tool, target: activity.target },
        data: { turns: state.turns },
      });
    },
  });

  const report = (run.resultText ?? '').trim();
  if (run.timedOut || !run.ok || report.length < 40) {
    logger.warn(
      { jobId: job.id, ok: run.ok, timedOut: run.timedOut, chars: report.length },
      'root-cause analysis produced nothing usable; fixing from the alert alone',
    );
    await emit(job, {
      stage: 'analyzing',
      status: 'done',
      key: 'job.analysis.empty',
      data: { timedOut: run.timedOut },
    });
    return null;
  }

  job.analysis = report;
  store.updateJob(job.id, { analysis: report });

  // The report itself goes into the thread — this is the comment the request
  // was actually about, so it is posted whole rather than summarised again.
  await emit(job, {
    stage: 'analyzing',
    status: 'done',
    key: 'job.analysis.done',
    params: { turns: run.turns },
    data: { turns: run.turns },
    body: report,
  });

  return report;
}
