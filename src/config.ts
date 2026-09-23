import { z } from 'zod';
import { resolve } from 'node:path';
import { FLOW_STATUSES } from './types.js';

const csv = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? fallback
        : v.split(',').map((s) => s.trim()).filter(Boolean),
    );

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v)));

/**
 * `z.enum` cannot be used on its own here: an unset variable arrives as
 * `undefined` and an unset-but-present one as `''`, and both have to mean
 * "take the default" rather than "reject the whole configuration".
 */
const oneOf = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : v.trim()))
    .pipe(z.enum(values as unknown as [string, ...string[]]))
    .transform((v) => v as T[number]);

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  LOCALE: z.enum(['ko', 'en']).default('ko'),
  LOG_LEVEL: z.string().default('info'),
  PORT: int(8080),

  // Empty is meaningful: it turns off the console login and the /v1 key check,
  // which is the intended shape for an internal-only deployment. See api/auth.ts.
  API_KEYS: csv(),

  SIGNOZ_WEBHOOK_USER: z.string().min(1),
  SIGNOZ_WEBHOOK_PASS: z.string().min(1),
  SIGNOZ_REQUIRE_LABEL: z.string().default('autofix'),
  SIGNOZ_SEVERITIES: csv(['critical', 'error']),
  SIGNOZ_ON_RESOLVED: z.enum(['ignore', 'cancel']).default('ignore'),
  // Only used to build a link back to SigNoz when the webhook carries none.
  // The SigNoz credential lives with the MCP server, not here.
  SIGNOZ_URL: z.string().default(''),
  ROUTES_FILE: z.string().default('./routes.yml'),

  // The inbound webhook above tells us an alert fired; this is the outbound side
  // that lets the agent go read the logs and traces behind it. Empty disables it,
  // so the agent simply works without SigNoz context rather than failing.
  SIGNOZ_MCP_URL: z.string().default(''),

  // The billing counterpart. A failed charge is diagnosed against Stripe, not
  // against the traces, so routes that point at the payment service can ask for
  // this server as well — see `mcp:` in routes.yml.
  //
  // Stripe's remote MCP server takes an ordinary API key as a bearer token,
  // which is what makes it usable from a headless container at all; the OAuth
  // flow it documents first needs a browser. Both must be set or the server is
  // simply not offered.
  //
  // The key MUST be a restricted, read-only one. The agent holding it has a
  // shell, and reading charges, subscriptions and events is the whole of what an
  // investigation needs — it never writes to Stripe.
  STRIPE_MCP_URL: z.string().default('https://mcp.stripe.com'),
  STRIPE_MCP_KEY: z.string().default(''),

  GITHUB_TOKEN: z.string().min(1),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  ALLOWED_REPOS: csv(['*/*']),
  DEFAULT_BASE_BRANCH: z.string().default('develop'),
  BRANCH_PREFIX: z.string().default('fix'),
  GIT_AUTHOR_NAME: z.string().default('임석현 (Andrew)'),
  GIT_AUTHOR_EMAIL: z.string().default('sjsh1623@flow.team'),

  // Which agent actually edits the code. Read once at boot — a job cannot start
  // under one provider and finish under another.
  AGENT_PROVIDER: z.enum(['claude', 'codex']).default('claude'),

  CLAUDE_BIN: z.string().default('claude'),
  CLAUDE_HOME: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-5'),
  CLAUDE_MAX_TURNS: int(40),
  CLAUDE_PERMISSION_MODE: z.string().default('acceptEdits'),
  CLAUDE_ALLOWED_TOOLS: csv(['Read', 'Glob', 'Grep', 'Edit', 'Write']),
  CLAUDE_DISALLOWED_TOOLS: csv(['Bash', 'WebFetch', 'WebSearch', 'Task']),
  AGENT_TIMEOUT_MS: int(900_000),

  // ── Codex CLI (local install) ──────────────────────────────
  CODEX_BIN: z.string().default('codex'),
  // Codex keeps its login session and config.toml here (default ~/.codex).
  // Must be writable: the session is refreshed in place, exactly as CLAUDE_HOME is.
  CODEX_HOME: z.string().optional(),
  // Empty on purpose — Codex picks its own current default, which survives a
  // release renaming whatever we would have pinned here.
  CODEX_MODEL: z.string().default(''),
  // workspace-write confines edits to the worktree and leaves network off.
  // Unlike the Claude driver we cannot deny the shell: Codex applies patches
  // through it, so the sandbox is what does that job instead.
  CODEX_SANDBOX: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .default('workspace-write'),
  CODEX_REASONING_EFFORT: z.string().default(''),
  // CODEX_HOME is the host's mounted ~/.codex; without this the agent inherits
  // the host user's config.toml. Auth still resolves through CODEX_HOME.
  CODEX_IGNORE_USER_CONFIG: bool(true),
  // Escape hatch for flags a future Codex release adds; empty by default.
  CODEX_EXTRA_ARGS: csv(),
  // Only for API-key auth. Left empty when using a `codex login` session, and
  // deliberately stripped from the agent environment in that case.
  OPENAI_API_KEY: z.string().default(''),

  // ── Triage & root-cause passes ─────────────────────────────
  // Two extra agent runs bracket the edit. Triage turns the raw alert into the
  // paragraph that gets registered in Flow; analysis goes back to SigNoz through
  // MCP and explains the firing before any code is touched. Either can be turned
  // off, and turning one off degrades the run rather than failing it.
  TRIAGE_ENABLED: bool(true),
  // Short on purpose: this pass reads one webhook body and writes a paragraph.
  TRIAGE_TIMEOUT_MS: int(180_000),
  // Off by default — triage runs before the Flow task exists, so every second
  // here is a second the board shows nothing. Turn it on when the alert bodies
  // are too thin to summarise on their own.
  TRIAGE_USE_SIGNOZ_MCP: bool(false),
  ANALYSIS_ENABLED: bool(true),
  ANALYSIS_TIMEOUT_MS: int(600_000),

  JOB_CONCURRENCY: int(1),
  VERIFY_TIMEOUT_MS: int(600_000),
  WORKSPACE_DIR: z.string().default('./data/work'),
  CACHE_DIR: z.string().default('./data/cache'),
  // Repositories dropped in here by hand are used instead of cloning from GitHub.
  // Nothing has to be placed here; an empty directory just means "always clone".
  REPOS_DIR: z.string().default('./repo'),
  DB_PATH: z.string().default('./data/db/morningmate-alert.db'),
  KEEP_WORKSPACE: bool(false),

  // ── Flow — https://api.flow.team/docs ──────────────────────
  // Not a guess any more: these are the documented User API routes. They stay
  // configurable only so a future rename does not need a release.
  FLOW_API_BASE: z.string().default('https://api.flow.team'),
  // Sent as the `x-flow-api-key` header on every call. Empty disables the REST
  // path; the run still completes and reports through the webhook, SSE and log.
  FLOW_API_KEY: z.string().default(''),
  // Which API surface that key belongs to. They are NOT interchangeable, and a
  // key used against the wrong one answers 401 "API Key 정보가 올바르지 않습니다":
  //
  //   user — a personal key (개발자 포털 → 개인용 → 내 API 키). `/user/*` routes.
  //          The author is resolved from the key, and this is the only surface
  //          with a comments endpoint, so it is the only one that can put the
  //          root-cause report and the PR link in the task's own thread.
  //   v1   — an institution admin key (/admin/openapi/keys). `/v1/*` routes.
  //          Can register a task and move it between columns, but has no
  //          comments endpoint at all — verified, /v1/comments/{postId} is a
  //          404 — so updates fall back to the webhook. Needs FLOW_REGISTER_ID.
  FLOW_API_SURFACE: oneOf(['user', 'v1'] as const, 'user'),
  // v1 only. The user the task is filed as; the personal surface takes this
  // from the key instead. Must be an active member of the target project.
  //
  // This is the **userId**, not the email. `/v2/employees` returns both and the
  // docs example shows an address, but an address is rejected with a 412
  // "…은(는) 유효하지 않은 작성자입니다" that reads like a permissions problem.
  FLOW_REGISTER_ID: z.string().default(''),
  // Default destination project. A route or an alert label can override it,
  // which is how the release and billing alerts keep their own boards.
  FLOW_PROJECT_ID: z.string().default(''),
  // Left empty on purpose: the correct paths follow from FLOW_API_SURFACE and
  // are filled in at startup. Set one only to pin it through a Flow rename.
  FLOW_TASK_CREATE_PATH: z.string().default(''),
  FLOW_TASK_STATUS_PATH: z.string().default(''),
  // Comments are addressed to the *post* id, not the task id. The create call
  // returns both; confusing them is a 404 that reads like a permission error.
  FLOW_COMMENT_PATH: z.string().default('/user/comments/{postId}'),
  // The task is registered as `request` and moved to `progress` the moment the
  // pipeline actually starts working, which is what a reader of the board sees.
  FLOW_STATUS_NEW: oneOf(FLOW_STATUSES, 'request'),
  FLOW_STATUS_RUNNING: oneOf(FLOW_STATUSES, 'progress'),
  FLOW_STATUS_DONE: oneOf(FLOW_STATUSES, 'complete'),
  // Not `hold`: a failed run leaves a thread that a person has to read, and
  // `feedback` is the column people actually look at.
  FLOW_STATUS_FAILED: oneOf(FLOW_STATUSES, 'feedback'),
  FLOW_TASK_PRIORITY: oneOf(['low', 'normal', 'high', 'urgent'] as const, 'normal'),
  // Flow ids assigned to every task this creates. Empty leaves it unassigned.
  FLOW_WORKERS: csv(),

  // ── Flow incoming webhooks ─────────────────────────────────
  // The other way into Flow, and the one that needs no admin API key: an
  // endpoint created in 웹훅 관리 against a fixed bot, action and target.
  // Posting `{title, text}` with the `x-flow-webhook-token` header creates one
  // item there. It returns no ids, so it can register a task but can neither
  // move it nor comment on it — flow.ts prefers the User API when a key exists.
  //
  // FLOW_WEBHOOK_URL / _TOKEN is the `default` endpoint. Extra named endpoints
  // are picked up from the environment as FLOW_WEBHOOK_<NAME>_URL / _TOKEN and
  // selected per alert with `flowWebhook:` in routes.yml — this is what keeps
  // billing alerts in their own room now that the relay is gone.
  FLOW_WEBHOOK_URL: z.string().default(''),
  FLOW_WEBHOOK_TOKEN: z.string().default(''),
  // `triaging` is deliberately absent: it runs before the task exists, so a
  // comment for it would have nowhere to go. Its output is the task body.
  FLOW_COMMENT_STAGES: csv([
    'registering',
    'analyzing',
    'editing',
    'verifying',
    'pr_opened',
    'final',
  ]),

  WEBHOOK_URL: z.string().default(''),
  WEBHOOK_SECRET: z.string().default(''),
});

export interface FlowWebhook {
  name: string;
  url: string;
  token: string;
}

export type Config = z.infer<typeof schema> & {
  workspaceDir: string;
  cacheDir: string;
  reposDir: string;
  dbPath: string;
  routesFile: string;
  /** Named Flow webhook endpoints, keyed by lower-case name. See below. */
  flowWebhooks: Record<string, FlowWebhook>;
  /** Resolved from FLOW_API_SURFACE unless explicitly overridden. */
  flowTaskCreatePath: string;
  flowTaskStatusPath: string;
};

/**
 * Collect `FLOW_WEBHOOK_<NAME>_URL` / `_TOKEN` pairs out of the environment.
 *
 * Declared here rather than in the zod schema because the set of names is the
 * operator's to choose — one endpoint per Flow project or chat room — and a
 * fixed schema would mean editing this file to add a room.
 *
 * A pair with a URL but no token is dropped with a warning rather than sent
 * unauthenticated, which Flow would reject anyway, once per progress event.
 */
function flowWebhooksFrom(env: NodeJS.ProcessEnv): Record<string, FlowWebhook> {
  const out: Record<string, FlowWebhook> = {};

  const add = (name: string, url?: string, token?: string) => {
    if (!url?.trim()) return;
    if (!token?.trim()) {
      process.stderr.write(
        `[config] FLOW_WEBHOOK ${name} has a URL but no token; ignoring that endpoint\n`,
      );
      return;
    }
    out[name] = { name, url: url.trim(), token: token.trim() };
  };

  add('default', env.FLOW_WEBHOOK_URL, env.FLOW_WEBHOOK_TOKEN);

  for (const key of Object.keys(env)) {
    const match = /^FLOW_WEBHOOK_([A-Z0-9_]+)_URL$/.exec(key);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    add(name, env[key], env[`FLOW_WEBHOOK_${match[1]}_TOKEN`]);
  }

  return out;
}

function build(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    // Fail at boot, loudly: a half-configured server that accepts an alert and
    // then cannot push is worse than one that refuses to start.
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;

  // A pinned path from the other surface is the one misconfiguration that
  // cannot be diagnosed from its symptom: calling /user/* with a v1 key answers
  // 401 "API Key 정보가 올바르지 않습니다", which reads as a bad key, and the key
  // is fine. Name it at boot instead.
  for (const [name, value] of [
    ['FLOW_TASK_CREATE_PATH', c.FLOW_TASK_CREATE_PATH],
    ['FLOW_TASK_STATUS_PATH', c.FLOW_TASK_STATUS_PATH],
  ] as const) {
    if (value && !value.startsWith(`/${c.FLOW_API_SURFACE}/`)) {
      process.stderr.write(
        `[config] ${name}=${value} does not match FLOW_API_SURFACE=${c.FLOW_API_SURFACE}; ` +
          'Flow will answer 401 for every call. Clear it to take the default.\n',
      );
    }
  }

  return {
    ...c,
    workspaceDir: resolve(c.WORKSPACE_DIR),
    cacheDir: resolve(c.CACHE_DIR),
    reposDir: resolve(c.REPOS_DIR),
    dbPath: resolve(c.DB_PATH),
    routesFile: resolve(c.ROUTES_FILE),
    flowWebhooks: flowWebhooksFrom(process.env),
    flowTaskCreatePath:
      c.FLOW_TASK_CREATE_PATH || `/${c.FLOW_API_SURFACE}/posts/projects/{projectId}/tasks`,
    flowTaskStatusPath:
      c.FLOW_TASK_STATUS_PATH ||
      `/${c.FLOW_API_SURFACE}/posts/projects/{projectId}/tasks/{taskId}/status`,
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  cached ??= build();
  return cached;
}

/** Glob match for an owner/name pair against allowlist entries such as "sjsh1623/*". */
export function repoAllowed(repo: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp(
      '^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$',
    );
    return re.test(repo);
  });
}
