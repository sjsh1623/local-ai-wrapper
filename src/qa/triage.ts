import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { activeProvider, runAgent } from '../agent/index.js';
import * as queue from '../jobs/queue.js';
import { maskEmails } from '../util/redact.js';
import { QA_LANES } from '../types.js';
import * as client from './client.js';
import * as store from './store.js';
import type { QaItem, QaLane, QaTriage } from '../types.js';

const cfg = getConfig();

/**
 * QA triage: the agent reads one post and says which lane it belongs in.
 *
 * This is the gate in front of everything expensive. Exploring the monolith
 * is where tokens go, and a post the agent could never fix — one customer's
 * data, a question, another team's area — should never reach that stage. So
 * the verdict is made from the post alone: no repository, no tools, a few
 * thousand tokens, and an answer in a fixed shape the console can show.
 *
 * It shares the alert pipeline's agent and its constraints (agent/triage.ts):
 * read-only, in an empty directory, on a short timeout. What differs is the
 * prompt and that the answer is JSON rather than prose.
 */

export interface TriageStatus {
  auto: boolean;
  queued: string[];
  running: string | null;
}

const pending: string[] = [];
let running: string | null = null;

export function status(): TriageStatus {
  return { auto: cfg.QA_TRIAGE_AUTO, queued: [...pending], running };
}

/** Ask for a verdict. A post already waiting or running is not queued twice. */
export function enqueue(postId: string): boolean {
  if (running === postId || pending.includes(postId)) return false;
  pending.push(postId);
  void pump();
  return true;
}

async function pump(): Promise<void> {
  if (running !== null) return;
  const next = pending.shift();
  if (next === undefined) return;
  running = next;
  try {
    await triageOne(next);
  } catch (err) {
    logger.warn({ postId: next, err: String(err) }, 'qa triage: failed');
    store.saveTriage(next, null, String(err));
  } finally {
    running = null;
    void pump();
  }
}

/**
 * The alert pipeline and this share one login session on disk, and two agent
 * processes refreshing it at once is the failure mode README warns about. So
 * a verdict waits for a running alert job rather than racing it.
 */
async function waitForAgent(): Promise<void> {
  const until = Date.now() + 10 * 60_000;
  while (queue.runningCount() > 0) {
    if (Date.now() > until) throw new Error('an alert job held the agent for over ten minutes');
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function triageOne(postId: string): Promise<void> {
  let item = store.getItem(postId);
  if (!item) throw new Error('no such post');

  // The verdict is about the post, so the post has to be current: read it
  // the same way opening it on the console does when nobody has yet, or when
  // it changed since.
  if (item.detailVersion !== item.version) {
    const [detail, comments] = await Promise.all([
      client.fetchDetail(postId),
      client.fetchComments(postId),
    ]);
    item = store.saveDetail(postId, detail, comments, new Date().toISOString()) ?? item;
  }

  await waitForAgent();

  const started = Date.now();
  // Outside any repository on purpose: the agent has nothing to read here but
  // the prompt, and an empty directory is the clearest way to say so.
  const scratch = await mkdtemp(join(tmpdir(), 'morningmate-alert-qa-triage-'));
  try {
    const run = await runAgent({
      cwd: scratch,
      prompt: await prompt(item, await rules()),
      readOnly: true,
      timeoutMs: cfg.QA_TRIAGE_TIMEOUT_MS,
      mcp: [],
      allowUntrackedCwd: true,
    });
    const text = (run.resultText ?? '').trim();
    if (!run.ok || run.timedOut || !text) {
      throw new Error(
        run.timedOut ? 'the agent timed out' : `the agent produced nothing (${run.stderr.slice(-300)})`,
      );
    }
    const verdict = parse(text);
    store.saveTriage(
      postId,
      {
        ...verdict,
        at: new Date().toISOString(),
        version: item.version,
        provider: activeProvider(),
        elapsedMs: Date.now() - started,
      },
      null,
    );
    logger.info(
      { postId, lane: verdict.lane, confidence: verdict.confidence, ms: Date.now() - started },
      'qa triage: verdict',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The agent's answer, as JSON.
 *
 * Models wrap JSON in prose and fences no matter how firmly they are asked
 * not to, so the first `{` to the last `}` is what gets parsed. Anything that
 * does not then carry a known lane and confidence is a failure, not a guess.
 */
function parse(text: string): Omit<QaTriage, 'at' | 'version' | 'provider' | 'elapsedMs'> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no JSON in the answer: ${text.slice(0, 200)}`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`the answer is not valid JSON: ${String(err)}`);
  }
  const lane = String(raw.lane ?? '').toUpperCase();
  if (!(QA_LANES as readonly string[]).includes(lane)) throw new Error(`unknown lane: ${lane}`);
  const confidence = String(raw.confidence ?? '').toLowerCase();
  if (!['high', 'medium', 'low'].includes(confidence)) {
    throw new Error(`unknown confidence: ${confidence}`);
  }
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [];
  return {
    lane: lane as QaLane,
    confidence: confidence as QaTriage['confidence'],
    summary: String(raw.summary ?? '').trim().slice(0, 300),
    reasons: list(raw.reasons),
    missing: list(raw.missing),
  };
}

const CATEGORY: Record<string, string> = { '0': '대기', '1': '진행', '2': '완료', '3': '보류' };

/**
 * The rules half of the prompt, from a file next to routes.yml.
 *
 * Read on every run rather than once at boot: the whole point of the file is
 * that a rule can be changed between two verdicts without a build or a
 * restart. A missing file is an error on the verdict, not at boot — the alert
 * side of this service does not depend on it.
 */
async function rules(): Promise<string> {
  const text = await readFile(cfg.qaTriagePromptFile, 'utf8');
  // The HTML comment at the top is for the person editing the file.
  const body = text.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
  if (body.length < 100) throw new Error(`${cfg.qaTriagePromptFile} is empty`);
  return body;
}

async function prompt(item: QaItem, rules: string): Promise<string> {
  const columns = Object.entries(item.columns)
    .map(([k, v]) => `- ${k}: ${v.join(', ')}`)
    .join('\n');
  const attachments = [
    ...item.images.map(() => '- 스크린샷 (이미지)'),
    ...item.attachments.map((a) => `- 파일: ${a.name}${/\.(mp4|mov|webm|avi|mkv|m4v)$/i.test(a.name) ? ' (영상 — 열어볼 수 없음)' : ''}`),
  ].join('\n');
  // Status changes and reassignments are system comments; they say how the
  // post has moved, which matters (a Re-request is a second round). A person's
  // comment is quoted; a system one is kept to a line.
  const comments = item.comments
    .slice(-15)
    .map((c) =>
      c.system
        ? `- [시스템 ${c.at.slice(0, 8)}] ${maskEmails(c.text).slice(0, 120)}`
        : `- [${c.authorName} ${c.at.slice(0, 8)}] ${maskEmails(c.text).slice(0, 600)}`,
    )
    .join('\n');

  return [
    rules,
    '',
    '---',
    '',
    `# QA 글 #${item.postId}`,
    `제목: ${maskEmails(item.title)}`,
    `상태: ${item.statusName} (${CATEGORY[item.statusCategory] ?? item.statusCategory})`,
    `등록자: ${item.registerName} · ${item.registeredAt.slice(0, 8)}`,
    item.section ? `섹션: ${item.section}` : '',
    columns ? `\n## 컬럼\n${columns}` : '',
    '',
    '## 본문',
    maskEmails(item.body || '(본문 없음)').slice(0, 6000),
    attachments ? `\n## 첨부\n${attachments}` : '\n## 첨부\n(없음)',
    comments ? `\n## 댓글 (최근 ${Math.min(item.comments.length, 15)}건)\n${comments}` : '\n## 댓글\n(없음)',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
