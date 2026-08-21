# Branchsmith

> 한국어 문서는 [README.ko.md](./README.ko.md) 를 보세요.

Branchsmith turns a SigNoz alert into a pull request.

It receives an alert, prepares an isolated checkout of the target repository,
lets the **Claude Code installed on this machine** edit the code, runs your
verification commands, commits, pushes a new branch, and opens a pull request —
reporting all nine stages as readable Korean or English text on a Flow post, a
webhook, and a live console.

```
SigNoz alert ─▶ hook adapter ─▶ queue ─▶ worker (claude + git) ─▶ push ─▶ Pull Request
                                   │
                                   └─▶ event bus ─▶ Flow comments · webhook · SSE console
```

- **No Anthropic API key.** The editing runs on your local Claude Code login.
- **Opt-in by label.** An alert without `autofix=true` (or a `routes.yml` entry)
  is ignored. A PR storm is structurally impossible.
- **New branches only.** Never commits to the base branch, never force-pushes.

---

## Requirements

- Docker and Docker Compose (or Node 22+ to run it directly)
- Claude Code installed and signed in on the host (`claude --version`)
- A GitHub personal access token with `repo` scope
- SigNoz with permission to add a notification channel

## Quick start

```bash
cp .env.example .env
$EDITOR .env          # API_KEYS, SIGNOZ_WEBHOOK_*, GITHUB_TOKEN, ALLOWED_REPOS

# Linux: match the container user to your own so ~/.claude stays writable
export APP_UID=$(id -u) APP_GID=$(id -g)

docker compose up -d --build
curl -s localhost:8080/readyz | jq
```

Then open <http://localhost:8080/> and paste one of your `API_KEYS`.

To run without Docker:

```bash
npm ci && npm run build
set -a && source .env && set +a
npm start
```

---

## Authentication — the one thing to get right

Branchsmith does not call the Anthropic API. It spawns the `claude` binary, which
signs in with the session stored in `~/.claude`. The container therefore mounts
your host session:

```yaml
- ${HOME}/.claude:/home/app/.claude          # read-WRITE
- ${HOME}/.claude.json:/home/app/.claude.json
```

**The mount must be writable.** A `:ro` mount works until the access token needs
refreshing, and then every job fails with an authentication error that looks
like nothing else. If `/readyz` reports `claude: false`, check this first.

For the same reason `JOB_CONCURRENCY` defaults to **1** — parallel `claude`
processes contend on the same credential file.

---

## Connecting SigNoz

In SigNoz, go to **Settings → Account Settings → Notification Channels → New
Channel**, choose **Webhook**, and fill in:

| Field | Value |
|---|---|
| Webhook URL | `http://<host>:8080/v1/hooks/signoz` |
| Username | `SIGNOZ_WEBHOOK_USER` |
| Password | `SIGNOZ_WEBHOOK_PASS` |
| Send resolved alerts | **off** (recommended) |

Or through the API:

```bash
curl "$SIGNOZ_URL/api/v1/channels" \
  -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" -H 'Content-Type: application/json' \
  --data-raw '{
    "name": "branchsmith",
    "webhook_configs": [{
      "send_resolved": false,
      "url": "http://host.docker.internal:8080/v1/hooks/signoz",
      "http_config": { "basic_auth": { "username": "signoz", "password": "…" } }
    }]
  }'
```

Three properties of that channel shape this design, and are worth knowing:

1. **Basic Auth only.** The channel cannot send custom headers, which is why
   `/v1/hooks/signoz` authenticates differently from the rest of the API.
2. **Alerts arrive in batches**, grouped by alert name, roughly every five
   minutes. The hook walks `alerts[]` and always answers `200` — a 4xx makes
   SigNoz redeliver the entire batch on a loop.
3. **Redelivery is normal.** Each alert's `fingerprint` becomes the idempotency
   key, so a still-firing alert opens exactly one pull request.

### Making an alert actionable

Add labels to the alert rule:

| Label | Meaning |
|---|---|
| `autofix: "true"` | **Required.** Without it the alert is ignored. |
| `repo: "owner/name"` | Target repository. Must match `ALLOWED_REPOS`. |
| `base: "develop"` | Base branch. Optional; falls back to `DEFAULT_BASE_BRANCH`. |
| `branch: "..."` | Explicit branch name. Optional. |
| `dryRun: "true"` | Report the diff, skip push and pull request. |
| `locale: "en"` | Override the language for this alert. |
| `flowPostId: "12345"` | Comment on an existing Flow post. |

`annotations.summary` and `annotations.description` become the instruction the
agent reads, so write them as you would write a bug report.

For rules that cannot carry labels, map them in `routes.yml` instead:

```yaml
routes:
  - match: { alertname: WebhookDeliveryFailureRate }
    repo: sjsh1623/morningmate-api
    base: develop
    verify: [npm ci, npm test]
    pr: { draft: true, labels: [autofix], reviewers: [sjsh1623] }
```

Labels win per field; the route fills in whatever the labels left out. An alert
matching neither is skipped.

---

## The nine stages

| # | Stage | What happens |
|---|---|---|
| 1 | `queued` | Auth, label gate, allowlist, fingerprint de-duplication |
| 2 | `preparing` | Mirror cache fetched, `git worktree` carved |
| 3 | `branching` | `fix/<alertname>-<id>` cut from the base branch |
| 4 | `planning` | `CLAUDE.md` / README / contributing notes merged into the prompt |
| 5 | `editing` | Local Claude Code edits; each tool call is relayed live |
| 6 | `verifying` | Your `verify` commands; one self-repair pass on failure |
| 7 | `committing` | Identity pinned locally, commit created |
| 8 | `pushing` | Plain push to the new branch — never `--force` |
| 9 | `pr_opened` | PR opened or updated, alert linked in the body |

Terminal states: `succeeded`, `no_changes`, `failed`, `cancelled`, `timed_out`.
Exactly one final event is emitted in every case.

---

## API

Everything under `/v1` takes `X-API-Key` (or the console cookie). The SigNoz hook
takes Basic Auth.

| Endpoint | Purpose |
|---|---|
| `POST /v1/hooks/signoz` | Receives alerts, one job per entry, always `200` |
| `POST /v1/jobs` | The normalized contract, for manual and repeat runs |
| `GET /v1/jobs` | Job list with `status` / `repo` filters |
| `GET /v1/jobs/:id` | Current stage, status, PR URL, Flow post |
| `GET /v1/jobs/:id/events` | SSE for one job, resumable via `Last-Event-ID` |
| `GET /v1/jobs/:id/log` | Every event, plus failed notification deliveries |
| `GET /v1/stream` | SSE across all jobs; replays the last 200 events |
| `POST /v1/jobs/:id/cancel` | Abort and clean up |
| `GET /healthz` `GET /readyz` | Liveness / full readiness |
| `GET /` | The live console |

```bash
curl -X POST localhost:8080/v1/jobs \
  -H 'X-API-Key: ***' -H 'Content-Type: application/json' -d '{
  "repo": "sjsh1623/morningmate-api",
  "base": "develop",
  "instruction": "Webhook delivery is failing at 12%. Add exponential-backoff retry.",
  "verify": ["npm ci", "npm test"],
  "pr": { "draft": true, "labels": ["autofix"], "reviewers": ["sjsh1623"] },
  "notify": { "kind": "flow", "postId": null },
  "locale": "en",
  "dryRun": true
}'
```

### Progress events

Every stage emits one identically shaped event. `text` is a finished sentence —
it goes straight into a Flow comment with no further formatting.

```json
{
  "jobId": "job_01K8ZQ4M7", "seq": 7,
  "stage": "editing", "status": "running", "progress": 0.55,
  "locale": "en",
  "text": "[5/9] Editing code — Edit src/notify/webhook.ts",
  "data": { "files": 2, "turns": 6 },
  "ts": "2026-08-21T02:14:33.812Z"
}
```

Webhook deliveries are signed: `x-branchsmith-signature: sha256=<hmac>` over the
raw body, keyed with `WEBHOOK_SECRET`.

---

## Flow comments

One job is one post and one comment thread. By default only four events become
comments — start, edit summary, verification failure, and the outcome — because
all nine would be unreadable. Tune with `FLOW_COMMENT_STAGES`.

> **The Flow API contract was not available when this was written.** The
> transport is therefore driven entirely by environment variables rather than
> hard-coded paths, so adapting it should not require a code change:
>
> ```
> FLOW_API_BASE=https://api.flow.team/v1
> FLOW_API_TOKEN=…
> FLOW_PROJECT_ID=…
> FLOW_AUTH_HEADER=Authorization      FLOW_AUTH_SCHEME=Bearer
> FLOW_POST_CREATE_PATH=/posts
> FLOW_POST_LOOKUP_PATH=/posts?projectId={projectId}&query={query}
> FLOW_COMMENT_PATH=/posts/{postId}/comments
> FLOW_POST_ID_FIELD=id
> ```
>
> If the real API's request or response bodies differ in shape, everything that
> needs changing is in `src/notify/transports/flow.ts` — `postIdFrom()` and the
> two request bodies. **Leaving `FLOW_API_BASE` empty disables the transport**;
> progress still reaches the webhook, the console, and the log.

---

## The console

`GET /` is a read-only view of what is happening right now: how many jobs are
running, and for each one, the alert it received and the work it is doing as a
message timeline. It subscribes to `/v1/stream` and reconnects on its own.

Five kinds of entry, styled apart so inbound and agent activity never blur:
`inbound` (the alert as received), `stage`, `tool` (what the agent touched),
`notify` (a delivery that failed), and `result` / `error`.

The only write it can perform is **cancel**.

---

## Guardrails

| | |
|---|---|
| Opt-in by label | No `autofix=true` and no route → no job |
| Allowlist | Anything outside `ALLOWED_REPOS` is refused with `403` |
| Idempotency | `fingerprint` means one PR per alert, however often it redelivers |
| New branches only | Never the base branch, never `--force` |
| No shell for the agent | `CLAUDE_DISALLOWED_TOOLS` blocks `Bash`; the server runs `verify` itself |
| Confined | The agent's working directory is that job's worktree |
| Caps | `CLAUDE_MAX_TURNS`, `AGENT_TIMEOUT_MS`, `VERIFY_TIMEOUT_MS` |
| Secrets | Tokens are scrubbed from every log line, event, and comment |
| Credentials | The GitHub token reaches git through a helper — never argv, URL, or reflog |
| Commit identity | Pinned in the worktree's local config, not inherited from a global |

Start a newly automated alert with `dryRun: true` for a few days.

---

## Configuration

Every variable, with defaults, is documented in [`.env.example`](./.env.example).
The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `LOCALE` | `ko` | `ko` or `en`; overridable per job |
| `API_KEYS` | — | Required. Comma separated |
| `SIGNOZ_WEBHOOK_USER` / `_PASS` | — | Required. Basic Auth for the hook |
| `SIGNOZ_REQUIRE_LABEL` | `autofix` | The opt-in label |
| `SIGNOZ_SEVERITIES` | `critical,error` | Severities acted on |
| `SIGNOZ_ON_RESOLVED` | `ignore` | Or `cancel` to abort an in-flight job |
| `GITHUB_TOKEN` | — | Required. `repo` scope |
| `ALLOWED_REPOS` | `sjsh1623/*` | Glob allowlist |
| `GIT_AUTHOR_EMAIL` | `sjsh1623@flow.team` | Pinned per repository |
| `CLAUDE_MODEL` | `claude-opus-5` | |
| `CLAUDE_DISALLOWED_TOOLS` | `Bash,WebFetch,WebSearch,Task` | What keeps the agent out of a shell |
| `JOB_CONCURRENCY` | `1` | Raise only if you understand the credential contention |
| `REPOS_DIR` | `./repo` | Repositories placed here by hand are read instead of cloning |
| `KEEP_WORKSPACE` | `false` | Keep a failed job's worktree for debugging |

---

## Troubleshooting

**`/readyz` says `claude: false`** — the mounted `~/.claude` is not writable, or
the host session has expired. Run `claude --version` on the host, then re-run
`docker compose up -d`.

**Alerts arrive but nothing happens** — check the log for `alert skipped`. Almost
always a missing `autofix=true` label, a severity outside `SIGNOZ_SEVERITIES`, or
a repository outside `ALLOWED_REPOS`.

**The same alert opened two PRs** — the alert rule is not emitting a stable
`fingerprint`. Give the job an explicit `idempotencyKey` instead.

**Flow comments never appear** — `FLOW_API_BASE` is empty (by design, until the
spec lands) or the paths do not match the real API. `GET /v1/jobs/:id/log`
returns `failedDeliveries` with the exact error.

**A job hangs in `editing`** — it is capped by `AGENT_TIMEOUT_MS` and will end as
`timed_out`. `POST /v1/jobs/:id/cancel` ends it now.

---

## Project layout

```
src/
  server.ts          Fastify bootstrap, route registration, restart reconciliation
  config.ts          env schema (zod) — fails at boot, not mid-job
  inbound/           signoz.ts (adapter) · routes.ts (routes.yml)
  api/               auth.ts · routes/{jobs,hooks,stream,health,console}.ts
  jobs/              store.ts (SQLite) · queue.ts · lifecycle.ts (the nine stages)
  workspace/         mirror.ts (bare cache, REPOS_DIR aware) · worktree.ts
  agent/             claude.ts (headless spawn) · stream.ts (NDJSON) · prompt.ts
  git/               credentials.ts · identity.ts · commit.ts · push.ts
  forge/             github.ts (Octokit)
  notify/            bus.ts · render.ts · transports/{flow,webhook,sse}.ts
  i18n/              index.ts · locales/{ko,en}.json
  console/           index.html · console.js
```
