import { mkdtemp, rm } from 'node:fs/promises';
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
      prompt: prompt(item),
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

function prompt(item: QaItem): string {
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
    '당신은 Morningmate(협업 SaaS) 개발팀의 QA 분류 담당입니다. 아래 QA 글 하나를 읽고,',
    '코딩 에이전트가 **flow-was 저장소(Java 1.8 + JSP + Preact 모놀리스)** 를 자동으로 고칠 수 있는 글인지 판정하세요.',
    '코드는 볼 수 없고 글만 봅니다. 추측하지 말고, 글에 적힌 사실만 근거로 쓰세요.',
    '',
    '## 레인 (하나만 고름)',
    '- A1: 레이아웃만의 문제 — 줄바꿈, 잘림, 겹침, 간격. SCSS만 고치면 끝남.',
    '- A2: 문구·언어 문제 — 한국어가 그대로 노출, 번역 누락, 하드코딩된 문자열. 코드에서 다국어 키로 바꾸는 수정.',
    '- B: 동작(로직) 버그 — 재현 경로가 명확하고 누구나 재현됨. 원인 분석과 수정 초안이 가능.',
    '- C: 특정 고객 계정·데이터·환경에서만 나는 문제 — 코드만으로는 재현도 확인도 어려움. 조사 리포트만.',
    '- D: 버그가 아님 — 확인 요청, 개선 제안, 기획 질문, 모바일 앱·위키·결제 등 다른 저장소 소관, 정보가 너무 없음.',
    '',
    '## 판정에 쓸 신호',
    '- 재현 경로가 적혀 있는가, "항상" 재현인가(Reproducibility 컬럼), 특정 계정이 언급되는가',
    '- 화면 단서가 있는가: 화면 문구, 메뉴 경로, 스크린샷. 영상만 있으면 에이전트는 볼 수 없음',
    '- Issue Type 컬럼: UI/UX·Language 는 A 쪽, Data 는 C 쪽 힌트. 단 컬럼은 등록자가 고른 것이라 본문이 우선',
    '- 제목의 머리표: [확인요청] [개선] 은 D, [고객오류] 는 C 가능성, 모바일/iOS/AOS/위키 는 D',
    '- 댓글에서 이미 원인이나 조치가 언급됐는가, Re-request 인가',
    '',
    '## 확신도',
    '- high: 레인이 명확하고 수정에 필요한 정보가 다 있음',
    '- medium: 레인은 맞아 보이나 빠진 정보가 있음',
    '- low: 글만으로는 판단이 어려움 (이 경우 보통 D 또는 C)',
    '',
    '## 출력',
    '아래 형식의 JSON 하나만 출력하세요. 앞뒤 설명, 코드 펜스 없이. 모든 문장은 한국어로.',
    '{',
    '  "lane": "A1|A2|B|C|D",',
    '  "confidence": "high|medium|low",',
    '  "summary": "이 글이 무엇에 대한 것인지 한 줄",',
    '  "reasons": ["이 레인으로 판정한 근거 — 글에 적힌 사실", "..."],',
    '  "missing": ["수정하려면 더 필요한 것. 없으면 빈 배열", "..."]',
    '}',
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
