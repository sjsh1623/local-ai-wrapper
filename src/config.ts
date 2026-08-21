import { z } from 'zod';
import { resolve } from 'node:path';

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

  API_KEYS: csv().refine((v) => v.length > 0, 'API_KEYS must list at least one key'),

  SIGNOZ_WEBHOOK_USER: z.string().min(1),
  SIGNOZ_WEBHOOK_PASS: z.string().min(1),
  SIGNOZ_REQUIRE_LABEL: z.string().default('autofix'),
  SIGNOZ_SEVERITIES: csv(['critical', 'error']),
  SIGNOZ_ON_RESOLVED: z.enum(['ignore', 'cancel']).default('ignore'),
  ROUTES_FILE: z.string().default('./routes.yml'),

  GITHUB_TOKEN: z.string().min(1),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  ALLOWED_REPOS: csv(['*/*']),
  DEFAULT_BASE_BRANCH: z.string().default('develop'),
  BRANCH_PREFIX: z.string().default('fix'),
  GIT_AUTHOR_NAME: z.string().default('임석현 (Andrew)'),
  GIT_AUTHOR_EMAIL: z.string().default('sjsh1623@flow.team'),

  CLAUDE_BIN: z.string().default('claude'),
  CLAUDE_HOME: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-5'),
  CLAUDE_MAX_TURNS: int(40),
  CLAUDE_PERMISSION_MODE: z.string().default('acceptEdits'),
  CLAUDE_ALLOWED_TOOLS: csv(['Read', 'Glob', 'Grep', 'Edit', 'Write']),
  CLAUDE_DISALLOWED_TOOLS: csv(['Bash', 'WebFetch', 'WebSearch', 'Task']),
  AGENT_TIMEOUT_MS: int(900_000),

  JOB_CONCURRENCY: int(1),
  VERIFY_TIMEOUT_MS: int(600_000),
  WORKSPACE_DIR: z.string().default('./data/work'),
  CACHE_DIR: z.string().default('./data/cache'),
  DB_PATH: z.string().default('./data/db/branchsmith.db'),
  KEEP_WORKSPACE: bool(false),

  FLOW_API_BASE: z.string().default(''),
  FLOW_API_TOKEN: z.string().default(''),
  FLOW_PROJECT_ID: z.string().default(''),
  FLOW_AUTH_HEADER: z.string().default('Authorization'),
  FLOW_AUTH_SCHEME: z.string().default('Bearer'),
  FLOW_POST_CREATE_PATH: z.string().default('/posts'),
  FLOW_POST_LOOKUP_PATH: z.string().default('/posts?projectId={projectId}&query={query}'),
  FLOW_COMMENT_PATH: z.string().default('/posts/{postId}/comments'),
  FLOW_POST_ID_FIELD: z.string().default('id'),
  FLOW_COMMENT_STAGES: csv(['queued', 'editing', 'verifying', 'final']),

  WEBHOOK_URL: z.string().default(''),
  WEBHOOK_SECRET: z.string().default(''),
});

export type Config = z.infer<typeof schema> & {
  workspaceDir: string;
  cacheDir: string;
  dbPath: string;
  routesFile: string;
};

function build(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    // Fail at boot, loudly: a half-configured server that accepts an alert and
    // then cannot push is worse than one that refuses to start.
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  return {
    ...c,
    workspaceDir: resolve(c.WORKSPACE_DIR),
    cacheDir: resolve(c.CACHE_DIR),
    dbPath: resolve(c.DB_PATH),
    routesFile: resolve(c.ROUTES_FILE),
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
