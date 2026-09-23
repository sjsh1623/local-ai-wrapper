# morningmate-alert

> 한국어 문서는 [README.ko.md](./README.ko.md) 를 보세요.

morningmate-alert turns a SigNoz alert into a pull request.

It receives an alert, has the agent write the incident note a person would have
written, registers that as a Flow task, diagnoses the firing against the live
telemetry, prepares an isolated checkout of the target repository, lets the
**coding agent installed on this machine** — Claude Code or Codex — edit the
code, runs your verification commands, commits, pushes a new branch, and opens a
pull request — reporting all eleven stages as readable Korean or English text on
the Flow task, a webhook, and a live console.

```
SigNoz ─▶ Node ─▶ Codex (triage) ─▶ Flow task ─▶ status: in progress
                                                      │
                     Codex + SigNoz MCP (root cause) ──┤──▶ comment
                                       code fix ───────┤
                                     GitHub PR ────────┴──▶ comment (PR link)
```

**SigNoz talks to Node and to nothing else.** It used to post to a Flow relay in
parallel with this service; that channel is gone, and Flow is now called from
here — after the alert has been summarised, so what lands on the board is an
incident note rather than an Alertmanager payload.

- **One switch picks the agent:** `AGENT_PROVIDER` (`claude` | `codex`). Both are
  installed in the image, so switching is a restart, not a rebuild.
- **No API key by default.** The editing runs on your local login session
  (Codex will also take `OPENAI_API_KEY` if you prefer).
- **Opt-in by label.** An alert without `autofix=true` (or a `routes.yml` entry)
  is ignored. A PR storm is structurally impossible.
- **New branches only.** Never commits to the base branch, never force-pushes.

---

## Requirements

- Docker and Docker Compose (or Node 22+ to run it directly)
- One signed-in agent session on the host — Claude Code (`~/.claude`) or Codex (`~/.codex`)
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

morningmate-alert does not call a model API directly. It spawns the `claude` or `codex`
binary, and that process signs in with the session mounted from your host:

```yaml
- ${HOME}/.claude:/home/app/.claude          # read-WRITE
- ${HOME}/.claude.json:/home/app/.claude.json
- ${HOME}/.codex:/home/app/.codex            # read-WRITE
```

**The mount must be writable.** A `:ro` mount works until the access token needs
refreshing, and then every job fails with an authentication error that looks like
nothing else. If `/readyz` reports `claude: false` or `codex: false`, check this first.

Create the directory on the host before the first `up`, or Docker creates it
root-owned and the agent cannot write to it:

```bash
mkdir -p ~/.codex && chmod 700 ~/.codex
```

For the same reason `JOB_CONCURRENCY` defaults to **1** — parallel agent processes
contend on the same credential file.

### Signing Codex in

Once, inside the container. It lands in the mounted `~/.codex/auth.json` and
survives restarts and rebuilds.

```bash
# ChatGPT account (use this on a headless box)
docker compose exec morningmate-alert codex login --device-auth

# or an API key
printenv OPENAI_API_KEY | docker compose exec -T morningmate-alert codex login --with-api-key

# check
docker compose exec morningmate-alert codex login status
```

Setting `OPENAI_API_KEY` in `.env` works too. When it is empty the variable is
stripped from the agent environment entirely, so a login session and a stray key
can never both be in play with no way to tell which one was used.

### The two agents are isolated differently

| | Claude Code | Codex |
|---|---|---|
| Shell | **denied** via `CLAUDE_DISALLOWED_TOOLS` | cannot be denied — it applies patches through one |
| What constrains it instead | tool allow/deny lists | `CODEX_SANDBOX=workspace-write` (no writes outside the worktree, no network) |
| Keeping host config out | `--strict-mcp-config` | `--ignore-user-config` (`CODEX_IGNORE_USER_CONFIG`) |

Codex has no choice but to use a shell, so **the sandbox is the only boundary**.
`CODEX_SANDBOX=danger-full-access` means removing it — don't.

---

## Connecting SigNoz

In SigNoz, go to **Settings → Account Settings → Notification Channels → New
Channel**, choose **Webhook**, and fill in:

| Field | Value |
|---|---|
| Webhook URL | `http://<host>:8080/v1/hooks/signoz` |
| Username | `SIGNOZ_WEBHOOK_USER` |
| Password | `SIGNOZ_WEBHOOK_PASS` |
| Send resolved alerts | **on** — `SIGNOZ_ON_RESOLVED` decides what happens to them |

Or through the API:

```bash
curl "$SIGNOZ_URL/api/v1/channels" \
  -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" -H 'Content-Type: application/json' \
  --data-raw '{
    "name": "morningmate-alert",
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

### What the webhook carries

The body is Alertmanager v4 and **cannot be templated.** The only levers on the
sending side are the alert rule's `labels` and `annotations`. One arriving alert
looks like this:

```json
{
  "status": "firing",
  "labels": {
    "alertname": "Disk usage over threshold — 85% warn / 92% critical",
    "severity": "critical", "threshold.name": "warning",
    "category": "saturation", "env": "production", "team": "saas",
    "host.name": "tokyo-tomcat-1", "mountpoint": "/var"
  },
  "annotations": {
    "summary": "…", "description": "…",
    "value": "87.4", "threshold": "85", "unit": "percent"
  },
  "startsAt": "2026-08-25T09:00:00Z",
  "endsAt": "0001-01-01T00:00:00Z",
  "generatorURL": "https://signoz.example.com/alerts/overview?ruleId=…",
  "fingerprint": "e1c6eb7cd109edc6"
}
```

Label keys keep their dots — `service.name`, not `service_name` — and the tier
label is `threshold.name`. `routes.yml` matches on the same spelling.

What the adapter does with it:

- **Every label is kept**, not a chosen few. `threshold.name` (which tier of an
  85%/92% rule actually crossed), `host.name`, `mountpoint` — the label nobody
  anticipated is usually the one that says which series is in trouble. Only
  `service.name` is renamed, to `service`, because the console and the commit
  trailer read it under that name.
- **`value` / `threshold` / `unit` are read.** They are `{{$value}}` and
  `{{$threshold}}` rendered at notify time, and the only quantitative fact in the
  payload. They become one line in the instruction:
  `Measured 87.4 percent against a threshold of 85 percent.`
- **Unrecognised annotations are passed through**, as a `From the alert rule:`
  block. Whatever else a rule writes down arrives intact.
- **The raw alert is preserved** in the job's `context._raw`, folded away in the
  console. Underscore-prefixed keys stay out of the prompt and the PR body.
- **The batch is logged once** (`SigNoz webhook received`). Which alerts became
  jobs is reconstructable later; what actually arrived is not, unless written down.
- **`endsAt` of `0001-01-01` is dropped** — it means still firing, not a time.
  `externalURL` can arrive as `http://localhost:8080`, in which case `SIGNOZ_URL`
  is used instead.

Put these annotations on a rule and they reach the agent verbatim, so it does not
have to guess what was measured from the alert's prose alone:

| Annotation | Example |
|---|---|
| `signal` | `traces` |
| `query` | `A: count() where has_error = true AND service.name IN (…) \| F1 = A / B * 100` |
| `group_by` | `service.name` |
| `window` | `5m window / 1m frequency` |
| `condition` | `critical: above 5 percent (all_the_times), recovers at 2 percent` |

All five come straight out of the rule definition, so refresh them when the rule
changes.

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

## The eleven stages

| # | Stage | What happens |
|---|---|---|
| 1 | `queued` | Auth, label gate, allowlist, fingerprint de-duplication |
| 2 | `triaging` | Agent turns the raw alert into a four-section incident note |
| 3 | `registering` | Flow task created with that note, then moved to *in progress* |
| 4 | `preparing` | Mirror cache fetched, `git worktree` carved |
| 5 | `branching` | `fix/<alertname>-<id>` cut from the base branch |
| 6 | `analyzing` | Read-only pass over SigNoz MCP + the source; report posted as a comment |
| 7 | `editing` | The agent edits, holding that report; each tool call is relayed live |
| 8 | `verifying` | Your `verify` commands; one self-repair pass on failure |
| 9 | `committing` | Identity pinned locally, commit created |
| 10 | `pushing` | Plain push to the new branch — never `--force` |
| 11 | `pr_opened` | PR opened or updated, its URL posted to the Flow thread |

Stages 2, 3 and 6 are the ones that were added when Flow moved behind Node.
Each of them **degrades rather than fails**: triage falling back leaves the raw
alert text as the task body, Flow being unreachable leaves the run reporting to
the log and the webhook, and an empty analysis simply means the fix is made from
the alert alone. None of the three can stop a repair from happening.

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
  "text": "[7/11] Editing code — Edit src/notify/webhook.ts",
  "data": { "files": 2, "turns": 6 },
  "ts": "2026-08-21T02:14:33.812Z"
}
```

Webhook deliveries are signed: `x-morningmate-alert-signature: sha256=<hmac>` over the
raw body, keyed with `WEBHOOK_SECRET`.

---

## Flow

There are three ways into Flow and they are **not** equivalent. `/readyz`
reports which one is live, because the difference is invisible from anywhere
else.

| | Register a task | Move it to 진행 | Comment on its thread |
|---|---|---|---|
| Personal key (`FLOW_API_SURFACE=user`) | ✅ | ✅ | ✅ |
| Admin key (`FLOW_API_SURFACE=v1`) | ✅ | ✅ | ❌ → webhook |
| Incoming webhook only | ✅ | ❌ | ❌ → webhook |

The two REST surfaces are documented at
[api.flow.team/docs](https://api.flow.team/docs). They are the same routes under
different prefixes, and **a key for one answers 401 on the other** — which reads
as a bad key when the key is fine. This is checked at boot.

```
POST  /{surface}/posts/projects/{projectId}/tasks                   업무 등록
PATCH /{surface}/posts/projects/{projectId}/tasks/{taskId}/status   업무 상태 수정
POST  /user/comments/{postId}                                       댓글 작성  ← user only
```

Things in that contract that cost time to find out:

- Authentication is the **`x-flow-api-key` header**, not a bearer token.
- **Every response nests under `response`** — `{"response":{"success":true,…}}`.
  Read past it and a successful creation looks like one that returned no ids.
- **`/v1` has no comments endpoint at all.** Both `/v1/comments/{postId}` and
  `/v1/posts/{postId}/comments` are 404. Comments exist only on the personal
  surface.
- **`registerId` is the userId, not the email.** `/v2/employees` returns both and
  the docs example shows an address; an address is refused with a 412
  "…은(는) 유효하지 않은 작성자입니다", which reads like a permissions problem.
  `/v1` wants it on the **status change** as well as on creation.
- `createTask` returns **both** a `taskId` and a `postId`. Status changes address
  the task; comments address the post. They are not interchangeable.
- Changing a task to the status it is already in is a 400. That happens on
  normal paths here, so it is swallowed.

```
FLOW_API_BASE=https://api.flow.team
FLOW_API_KEY=…
FLOW_API_SURFACE=v1                  # user | v1
FLOW_REGISTER_ID=…                   # v1 only. userId, NOT the email
FLOW_PROJECT_ID=…
FLOW_STATUS_NEW=request              # request | progress | feedback | complete | hold
FLOW_STATUS_RUNNING=progress
FLOW_STATUS_DONE=complete
FLOW_STATUS_FAILED=feedback
FLOW_COMMENT_STAGES=analyzing,pr_opened,final
```

### What lands on the task

The task and the comments that follow it are one incident report in three parts.

| Where | What |
|---|---|
| Task body (triage) | **어디서** service, environment, the route or job that failed, when · **누가/무엇이** what triggered it and how many callers are hit · **무엇이** the symptom, measured value against threshold, exception type · **왜** the mechanism and the suspected code path · **확인할 것** |
| Root-cause comment | **어디서** (`file:line`) · **누가/무엇이** · **왜** step by step · **근거** the queries, traces and lines actually read · **영향 범위** · **수정 방향** · **확신도** |
| PR comment | **원인** one line · **수정 내용** the agent's own account of the change · **변경 파일** · diffstat · **PR link** |

The task title is `<alertname> — <repo>`, with no prefix in front of it. Every
task on that board was opened from here, so a prefix said nothing and cost 200
characters of title.

**The body and every comment are plain text.** Flow renders neither Markdown nor
HTML, so `**bold**` arrives as two asterisks and a fence as three backticks. The
headings in the table above therefore go out as `■ 어디서`, and the triage and
root-cause prompts say so explicitly. The divider is a rule character, not
`---`. The GitHub PR body is the exception and stays Markdown — that one is
rendered.

This is why the triage pass queries SigNoz (`TRIAGE_USE_SIGNOZ_MCP=true`): the
alert body alone cannot answer where, who or why, and with it off the task body
fills up with "확인되지 않음". The prompts require exactly that phrase instead of
a guess, so a blank is a statement that the telemetry does not show it — not
laziness.

---

### Incoming webhooks

A webhook endpoint (개발자 포털 → 웹훅 관리) already fixes the bot, the action and
the target project, so all that is sent is `{title, text}` with an
`x-flow-webhook-token` header. It answers
`{"response":{"success":true,"code":200,"message":"success"}}` — **no ids** — so
it can create an item and nothing else. 60 requests per minute per endpoint.

```
FLOW_WEBHOOK_URL=…            FLOW_WEBHOOK_TOKEN=…            # the `default` endpoint
FLOW_WEBHOOK_BILLING_URL=…    FLOW_WEBHOOK_BILLING_TOKEN=…    # any FLOW_WEBHOOK_<NAME>_*
```

Whenever comments are not available, updates are posted through the webhook as
separate items titled with the alert name and the job id. That is what makes
them findable; it is not a thread, and a personal key is what turns it into one.

### Sending different alerts to different boards

Until Node took over, `signoz-flow-relay` read the `team` label off each alert
and posted release and billing alerts into their own rooms. That fan-out now
lives in `routes.yml`, and under a v1 key both halves are needed — the project
for the task, the webhook for the updates:

```yaml
  - match: { team: billing }
    repo: madrascheck-dev/morningmate-payment
    flowProjectId: "2954511"     # [Production] Morningmate Billing Signoz
    flowWebhook: billing         # FLOW_WEBHOOK_BILLING_URL
    dryRun: true
```

Without them, every alert lands on `FLOW_PROJECT_ID` and the `default` webhook.
That is the one behaviour the relay had and a bare cut-over would lose.

---

## Billing alerts and the Stripe MCP server

The truth about a failed payment is in Stripe, not in the traces. The logs say
"the charge failed" and stop there; *why* it failed — the decline code, whether
Stripe retried, whether the webhook reached us, whether it is one customer or
all of them — only comes out of the Stripe objects themselves. So billing routes
open a second MCP server alongside SigNoz:

```yaml
  - match: { service.name: tokyo-billing-production }
    repo: madrascheck-dev/morningmate-payment
    flowProjectId: "2954511"
    flowWebhook: billing
    mcp: [stripe]                # SigNoz is always on; this is what to add
```

`mcp` is carried into stages 3, 6 and 7 — triage, root-cause, and the fix. An
alert rule carrying an `mcp: stripe` label overrides its route, like every other
field here.

Turning it on is one key in `.env`:

```bash
STRIPE_MCP_URL=https://mcp.stripe.com
STRIPE_MCP_KEY=rk_live_...        # read-only restricted key
```

Stripe's remote MCP server accepts an API key as a bearer token, which is what
makes it usable from a headless container at all — the OAuth flow its
documentation leads with needs a browser. The key must be a **read-only
restricted key**: the agent holding it has a shell, and reading is the whole of
what an investigation needs. The Codex driver passes it as
`bearer_token_env_var` rather than on argv, and deletes it from the environment
of any job that was not offered Stripe.

An empty `STRIPE_MCP_KEY` logs one warning and runs without it — a worse
diagnosis, never a failed job. `/readyz` reports which of the two it is under
`stripeMcp`.

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
| `SIGNOZ_MCP_URL` | — | Empty = the root-cause stage reads the repository only |
| `STRIPE_MCP_URL` | `https://mcp.stripe.com` | Offered to billing routes only (`mcp: [stripe]`) |
| `STRIPE_MCP_KEY` | — | A **read-only restricted key**. Empty = diagnose without Stripe |
| `TRIAGE_ENABLED` | `true` | Off = the raw alert text becomes the Flow task body |
| `TRIAGE_TIMEOUT_MS` | `180000` | Short: the board is empty until this returns |
| `TRIAGE_USE_SIGNOZ_MCP` | `false` | Triage stays fast; the analysis pass always has MCP |
| `ANALYSIS_ENABLED` | `true` | Off = the fix is made from the alert alone |
| `ANALYSIS_TIMEOUT_MS` | `600000` | |
| `FLOW_API_KEY` | — | `x-flow-api-key`. Empty = Flow off |
| `FLOW_API_SURFACE` | `user` | `user` (personal key) or `v1` (admin key). A mismatch is a 401 |
| `FLOW_REGISTER_ID` | — | v1 only. The **userId**, not the email |
| `FLOW_WEBHOOK_URL` / `_TOKEN` | — | The `default` incoming webhook |
| `FLOW_PROJECT_ID` | — | Default board; `routes.yml` can override per alert |
| `FLOW_STATUS_RUNNING` | `progress` | The column a task moves to when work starts |
| `FLOW_COMMENT_STAGES` | `registering,analyzing,editing,verifying,pr_opened,final` | Which stages earn a comment |
| `ALLOWED_REPOS` | `sjsh1623/*` | Glob allowlist |
| `GIT_AUTHOR_EMAIL` | `sjsh1623@flow.team` | Pinned per repository |
| `AGENT_PROVIDER` | `claude` | `claude` or `codex` — which agent edits the code |
| `CLAUDE_MODEL` | `claude-opus-5` | |
| `CLAUDE_DISALLOWED_TOOLS` | `Bash,WebFetch,WebSearch,Task` | What keeps the agent out of a shell |
| `CODEX_MODEL` | — | empty = Codex picks its own default |
| `CODEX_SANDBOX` | `workspace-write` | Codex's only boundary. Do not use `danger-full-access` |
| `CODEX_IGNORE_USER_CONFIG` | `true` | ignore the mounted host `~/.codex/config.toml` |
| `OPENAI_API_KEY` | — | empty = use the login session; stripped from the agent env when empty |
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
  jobs/              store.ts (SQLite) · queue.ts · lifecycle.ts (the eleven stages)
  workspace/         mirror.ts (bare cache, REPOS_DIR aware) · worktree.ts
  agent/             claude.ts (headless spawn) · stream.ts (NDJSON) · prompt.ts
  git/               credentials.ts · identity.ts · commit.ts · push.ts
  forge/             github.ts (Octokit)
  notify/            bus.ts · render.ts · transports/{flow,webhook,sse}.ts
  i18n/              index.ts · locales/{ko,en}.json
  console/           index.html · console.js
```
