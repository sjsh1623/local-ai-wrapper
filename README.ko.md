# Branchsmith

> For the English documentation, see [README.md](./README.md).

Branchsmith 는 SigNoz 알럿 하나를 Pull Request 하나로 바꿔 주는 로컬 서버입니다.

알럿을 받으면 대상 저장소의 격리된 작업 공간을 만들고, **이 컴퓨터에 설치된
Claude Code** 가 직접 코드를 고칩니다. 그다음 설정된 검증 명령을 돌리고, 커밋하고,
새 브랜치를 푸시하고, Pull Request 를 엽니다. 진행 상황은 9단계로 나뉘어 Flow
게시글의 댓글, 웹훅, 그리고 실시간 콘솔에 한국어(또는 영어) 문장으로 남습니다.

```
SigNoz 알럿 ─▶ 훅 어댑터 ─▶ 큐 ─▶ 워커(claude + git) ─▶ 푸시 ─▶ Pull Request
                              │
                              └─▶ 이벤트 버스 ─▶ Flow 댓글 · 웹훅 · SSE 콘솔
```

- **Anthropic API 키를 쓰지 않습니다.** 코드 수정은 로컬 Claude Code 로그인 세션으로 돕니다.
- **라벨 opt-in.** `autofix=true` 라벨(또는 `routes.yml` 항목)이 없는 알럿은 무시합니다.
  실수로 전체 알럿이 PR 을 만드는 일이 구조적으로 불가능합니다.
- **새 브랜치만 건드립니다.** base 브랜치에 커밋하지 않고, force-push 도 하지 않습니다.

---

## 준비물

- Docker 와 Docker Compose (또는 직접 실행할 Node 22+)
- 호스트에 설치되어 로그인된 Claude Code (`claude --version` 확인)
- `repo` 권한이 있는 GitHub Personal Access Token
- SigNoz 알림 채널을 추가할 수 있는 권한

## 빠른 시작

```bash
cp .env.example .env
$EDITOR .env          # API_KEYS, SIGNOZ_WEBHOOK_*, GITHUB_TOKEN, ALLOWED_REPOS

# Linux 라면 컨테이너 사용자를 내 계정과 맞춰야 ~/.claude 에 쓸 수 있습니다
export APP_UID=$(id -u) APP_GID=$(id -g)

docker compose up -d --build
curl -s localhost:8080/readyz | jq
```

브라우저에서 <http://localhost:8080/> 을 열고 `API_KEYS` 중 하나를 입력하면 콘솔이 뜹니다.

Docker 없이 돌리려면:

```bash
npm ci && npm run build
set -a && source .env && set +a
npm start
```

---

## 인증 — 이 설계에서 가장 중요한 부분

Branchsmith 는 Anthropic API 를 호출하지 않습니다. `claude` 실행 파일을 직접 띄우고,
그 프로세스는 `~/.claude` 에 저장된 로그인 세션을 씁니다. 그래서 컨테이너가 호스트의
세션을 그대로 마운트합니다.

```yaml
- ${HOME}/.claude:/home/app/.claude          # 읽기·쓰기
- ${HOME}/.claude.json:/home/app/.claude.json
```

**이 마운트는 반드시 쓰기 가능해야 합니다.** `:ro` 로 걸면 토큰을 갱신하기 전까지는
잘 돌다가, 갱신 시점부터 모든 작업이 원인을 알기 어려운 인증 오류로 실패합니다.
`/readyz` 가 `claude: false` 를 돌려주면 여기부터 확인하세요.

같은 이유로 `JOB_CONCURRENCY` 의 기본값은 **1** 입니다. 여러 `claude` 프로세스가 같은
자격 증명 파일을 동시에 갱신하면 세션이 깨질 수 있습니다.

---

## SigNoz 연결

SigNoz 에서 **Settings → Account Settings → Notification Channels → New Channel** 로
가서 **Webhook** 을 고르고 다음을 채웁니다.

| 항목 | 값 |
|---|---|
| Webhook URL | `http://<호스트>:8080/v1/hooks/signoz` |
| Username | `SIGNOZ_WEBHOOK_USER` |
| Password | `SIGNOZ_WEBHOOK_PASS` |
| Send resolved alerts | **끄기** (권장) |

API 로 등록할 수도 있습니다.

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

이 채널의 성질 셋이 설계를 그대로 결정했으니 알아 두면 좋습니다.

1. **인증이 Basic Auth 뿐입니다.** 커스텀 헤더를 못 붙입니다. `/v1/hooks/signoz` 만
   나머지 API 와 인증 방식이 다른 이유입니다.
2. **알럿이 묶여서 옵니다.** alertname 기준으로 그룹핑되어 기본 5분 간격으로 전송됩니다.
   훅은 `alerts[]` 를 순회하고 **항상 `200`** 을 돌려줍니다 — 4xx 를 주면 SigNoz 가
   배치 전체를 계속 재전송합니다.
3. **재전송이 정상 동작입니다.** 각 알럿의 `fingerprint` 를 멱등 키로 쓰기 때문에,
   계속 firing 인 알럿이라도 PR 은 하나만 열립니다.

### 알럿을 자동화 대상으로 만들기

알럿 룰에 라벨을 추가합니다.

| 라벨 | 의미 |
|---|---|
| `autofix: "true"` | **필수.** 없으면 그 알럿은 무시됩니다. |
| `repo: "owner/name"` | 대상 저장소. `ALLOWED_REPOS` 안에 있어야 합니다. |
| `base: "develop"` | 기준 브랜치. 없으면 `DEFAULT_BASE_BRANCH`. |
| `branch: "..."` | 브랜치 이름 직접 지정. 선택. |
| `dryRun: "true"` | diff 만 보고하고 푸시·PR 은 건너뜁니다. |
| `locale: "en"` | 이 알럿에 한해 언어를 바꿉니다. |
| `flowPostId: "12345"` | 기존 Flow 게시글에 댓글을 답니다. |

`annotations.summary` 와 `annotations.description` 이 에이전트가 읽는 지시문이 됩니다.
버그 리포트를 쓰듯 적어 주세요.

라벨을 넣을 수 없는 룰은 `routes.yml` 로 매핑합니다.

```yaml
routes:
  - match: { alertname: WebhookDeliveryFailureRate }
    repo: sjsh1623/morningmate-api
    base: develop
    verify: [npm ci, npm test]
    pr: { draft: true, labels: [autofix], reviewers: [sjsh1623] }
```

필드 단위로 라벨이 우선하고, 라벨이 비운 자리를 라우트가 채웁니다. 둘 다 해당되지
않는 알럿은 건너뜁니다.

---

## 작업 9단계

| # | 단계 | 하는 일 |
|---|---|---|
| 1 | `queued` | 인증 · 라벨 게이트 · 허용 목록 · fingerprint 중복 확인 |
| 2 | `preparing` | 미러 캐시 갱신 후 `git worktree` 생성 |
| 3 | `branching` | base 기준으로 `fix/<alertname>-<id>` 분기 |
| 4 | `planning` | `CLAUDE.md` · README · 기여 규칙을 지시문과 합침 |
| 5 | `editing` | 로컬 Claude Code 가 수정, 도구 호출을 실시간 중계 |
| 6 | `verifying` | `verify` 명령 실행, 실패 시 자가 수정 1회 |
| 7 | `committing` | identity 를 저장소 로컬 설정에 고정하고 커밋 |
| 8 | `pushing` | 새 브랜치로 일반 푸시 — `--force` 없음 |
| 9 | `pr_opened` | PR 생성 또는 갱신, 본문에 알럿 링크 첨부 |

종료 상태는 `succeeded` · `no_changes` · `failed` · `cancelled` · `timed_out`
다섯 가지이고, 어느 쪽이든 마지막 이벤트가 정확히 한 번 발행됩니다.

---

## API

`/v1` 아래는 모두 `X-API-Key`(또는 콘솔 쿠키)를 씁니다. SigNoz 훅만 Basic Auth 입니다.

| 엔드포인트 | 역할 |
|---|---|
| `POST /v1/hooks/signoz` | 알럿 수신 · 건별 작업 생성 · 항상 `200` |
| `POST /v1/jobs` | 정규 계약. 수동 실행과 재실행용 |
| `GET /v1/jobs` | 작업 목록 (`status` · `repo` 필터) |
| `GET /v1/jobs/:id` | 현재 단계 · 상태 · PR URL · Flow 글 번호 |
| `GET /v1/jobs/:id/events` | 작업 하나의 SSE (`Last-Event-ID` 로 재개) |
| `GET /v1/jobs/:id/log` | 전체 이벤트 + 전송 실패 기록 |
| `GET /v1/stream` | 전체 작업 SSE · 최근 200건 리플레이 |
| `POST /v1/jobs/:id/cancel` | 중단 및 작업 공간 정리 |
| `GET /healthz` `GET /readyz` | 살아 있는지 / 실제로 작업을 끝낼 수 있는지 |
| `GET /` | 진행 콘솔 |

```bash
curl -X POST localhost:8080/v1/jobs \
  -H 'X-API-Key: ***' -H 'Content-Type: application/json' -d '{
  "repo": "sjsh1623/morningmate-api",
  "base": "develop",
  "instruction": "웹훅 발송 실패율이 12%입니다. 지수 백오프 재시도를 추가해 주세요.",
  "verify": ["npm ci", "npm test"],
  "pr": { "draft": true, "labels": ["autofix"], "reviewers": ["sjsh1623"] },
  "notify": { "kind": "flow", "postId": null },
  "locale": "ko",
  "dryRun": true
}'
```

### 진행 이벤트

모든 단계가 같은 모양의 이벤트를 하나씩 올립니다. `text` 는 그대로 읽을 수 있는
완성된 문장이라 Flow 댓글에 가공 없이 들어갑니다.

```json
{
  "jobId": "job_01K8ZQ4M7", "seq": 7,
  "stage": "editing", "status": "running", "progress": 0.55,
  "locale": "ko",
  "text": "[5/9] 코드 수정 — Edit src/notify/webhook.ts",
  "data": { "files": 2, "turns": 6 },
  "ts": "2026-08-21T02:14:33.812Z"
}
```

웹훅 전송에는 서명이 붙습니다 — `WEBHOOK_SECRET` 으로 원문 본문을 HMAC 한
`x-branchsmith-signature: sha256=<hmac>` 헤더입니다.

---

## Flow 댓글

작업 1건 = 게시글 1건 + 댓글 스레드 1개입니다. 9단계를 전부 달면 읽을 수 없으므로
기본은 **4건** — 시작, 수정 요약, 검증 실패, 최종 결과 — 만 댓글로 남깁니다.
`FLOW_COMMENT_STAGES` 로 조정하세요.

> **작성 시점에 Flow API 스펙이 없었습니다.** 그래서 이 전송 채널은 경로를 코드에
> 박지 않고 전부 환경 변수로 뺐습니다. 스펙이 오면 대부분 `.env` 수정만으로 맞출 수
> 있습니다.
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
> 실제 API 의 요청·응답 본문 모양이 다르면 고칠 곳은 `src/notify/transports/flow.ts`
> 한 파일 — `postIdFrom()` 과 두 개의 요청 본문뿐입니다. **`FLOW_API_BASE` 를 비워
> 두면 이 채널은 꺼집니다.** 그동안에도 진행 상황은 웹훅 · 콘솔 · 로그로 남습니다.

---

## 진행 콘솔

`GET /` 은 지금 무슨 일이 벌어지는지 보는 읽기 전용 화면입니다. 몇 건이 돌고 있는지,
각 작업이 어떤 알럿을 받아 무슨 일을 하고 있는지를 메시지 타임라인으로 보여 줍니다.
`/v1/stream` 을 구독하고 끊기면 스스로 다시 붙습니다.

타임라인 항목은 다섯 종류이고, 밖에서 들어온 것과 에이전트가 한 일이 섞이지 않도록
생김새를 달리했습니다 — `inbound`(받은 알럿), `stage`(단계 전환),
`tool`(에이전트가 만진 것), `notify`(전송 실패), `result` / `error`.

이 화면에서 할 수 있는 쓰기 동작은 **취소** 하나뿐입니다.

---

## 안전장치

| | |
|---|---|
| 라벨 opt-in | `autofix=true` 도 라우트도 없으면 작업이 생기지 않습니다 |
| 허용 목록 | `ALLOWED_REPOS` 밖은 `403` 으로 거절 |
| 멱등성 | `fingerprint` 기준 — 몇 번을 재전송해도 PR 은 하나 |
| 새 브랜치만 | base 브랜치 직접 커밋 없음, `--force` 없음 |
| 에이전트에게 셸 없음 | `CLAUDE_DISALLOWED_TOOLS` 로 `Bash` 차단, `verify` 는 서버가 직접 실행 |
| 격리 | 에이전트 작업 디렉터리는 그 작업의 worktree 로 고정 |
| 상한 | `CLAUDE_MAX_TURNS` · `AGENT_TIMEOUT_MS` · `VERIFY_TIMEOUT_MS` |
| 비밀 | 토큰·키는 로그·이벤트·댓글에서 발송 직전에 치환 |
| 자격 증명 | GitHub 토큰은 헬퍼로 전달 — argv·원격 URL·reflog 어디에도 남지 않습니다 |
| 커밋 identity | 전역 설정을 믿지 않고 저장소 로컬 설정에 고정 |

새 알럿을 처음 자동화에 물릴 때는 `dryRun: true` 로 며칠 돌려 보길 권합니다.

---

## 설정

모든 변수와 기본값은 [`.env.example`](./.env.example) 에 정리되어 있습니다.
그중 중요한 것들:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `LOCALE` | `ko` | `ko` 또는 `en`, 작업별 덮어쓰기 가능 |
| `API_KEYS` | — | 필수. 쉼표 구분 |
| `SIGNOZ_WEBHOOK_USER` / `_PASS` | — | 필수. 훅의 Basic Auth |
| `SIGNOZ_REQUIRE_LABEL` | `autofix` | opt-in 라벨 이름 |
| `SIGNOZ_SEVERITIES` | `critical,error` | 처리할 심각도 |
| `SIGNOZ_ON_RESOLVED` | `ignore` | `cancel` 이면 진행 중 작업을 중단 |
| `GITHUB_TOKEN` | — | 필수. `repo` 권한 |
| `ALLOWED_REPOS` | `sjsh1623/*` | 허용 저장소 글롭 |
| `GIT_AUTHOR_EMAIL` | `sjsh1623@flow.team` | 저장소별로 고정됨 |
| `CLAUDE_MODEL` | `claude-opus-5` | |
| `CLAUDE_DISALLOWED_TOOLS` | `Bash,WebFetch,WebSearch,Task` | 에이전트를 셸에서 떼어 놓는 장치 |
| `JOB_CONCURRENCY` | `1` | 자격 증명 경합을 이해한 뒤에만 올리세요 |
| `REPOS_DIR` | `./repo` | 여기에 직접 넣어둔 저장소는 clone 하지 않고 읽는다 |
| `KEEP_WORKSPACE` | `false` | 실패한 작업의 worktree 를 남겨 디버깅 |

---

## 문제 해결

**`/readyz` 가 `claude: false`** — 마운트한 `~/.claude` 가 쓰기 불가이거나 호스트
세션이 만료됐습니다. 호스트에서 `claude --version` 을 확인한 뒤
`docker compose up -d` 를 다시 하세요.

**알럿은 오는데 아무 일도 안 일어남** — 로그에서 `alert skipped` 를 찾아보세요.
대부분 `autofix=true` 라벨 누락, `SIGNOZ_SEVERITIES` 밖의 심각도, 또는
`ALLOWED_REPOS` 밖의 저장소입니다.

**같은 알럿인데 PR 이 두 개 생김** — 알럿 룰이 안정적인 `fingerprint` 를 내지 않는
경우입니다. 작업에 `idempotencyKey` 를 직접 지정하세요.

**Flow 댓글이 안 달림** — `FLOW_API_BASE` 가 비어 있거나(스펙이 올 때까지의 기본값),
경로가 실제 API 와 다릅니다. `GET /v1/jobs/:id/log` 의 `failedDeliveries` 에 정확한
오류가 남습니다.

**작업이 `editing` 에서 멈춤** — `AGENT_TIMEOUT_MS` 상한에 걸려 `timed_out` 으로
끝납니다. 바로 끝내려면 `POST /v1/jobs/:id/cancel`.

---

## 디렉터리

```
src/
  server.ts          Fastify 부트스트랩 · 라우트 등록 · 재시작 정합성 복구
  config.ts          env 스키마 검증(zod) — 작업 중이 아니라 시작 시점에 실패
  inbound/           signoz.ts (어댑터) · routes.ts (routes.yml)
  api/               auth.ts · routes/{jobs,hooks,stream,health,console}.ts
  jobs/              store.ts (SQLite) · queue.ts · lifecycle.ts (9단계)
  workspace/         mirror.ts (베어 캐시) · worktree.ts
  agent/             claude.ts (헤드리스 실행) · stream.ts (NDJSON) · prompt.ts
  git/               credentials.ts · identity.ts · commit.ts · push.ts
  forge/             github.ts (Octokit)
  notify/            bus.ts · render.ts · transports/{flow,webhook,sse}.ts
  i18n/              index.ts · locales/{ko,en}.json
  console/           index.html · console.js
```
