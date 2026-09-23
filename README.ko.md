# morningmate-alert

> For the English documentation, see [README.md](./README.md).

morningmate-alert 는 SigNoz 알럿 하나를 Pull Request 하나로 바꿔 주는 로컬 서버입니다.

알럿을 받으면 먼저 에이전트가 **사람이 쓸 법한 장애 노트**로 정리하고, 그것을 Flow
업무로 등록한 뒤 상태를 '진행'으로 바꿉니다. 이어서 SigNoz 텔레메트리를 직접 뒤져
원인을 분석해 댓글로 공유하고, 대상 저장소의 격리된 작업 공간에서 **이 컴퓨터에
설치된 코딩 에이전트**(Claude Code 또는 Codex)가 코드를 고칩니다. 그다음 설정된
검증 명령을 돌리고, 커밋하고, 새 브랜치를 푸시하고, Pull Request 를 열어 그 주소를
다시 댓글로 답니다. 진행 상황은 11단계로 나뉘어 Flow 업무의 댓글, 웹훅, 실시간
콘솔에 한국어(또는 영어) 문장으로 남습니다.

```
SigNoz ─▶ Node ─▶ Codex(간단 정리) ─▶ Flow 업무 등록 ─▶ 상태: 진행
                                                          │
                    Codex + SigNoz MCP (원인 분석) ────────┤──▶ 댓글
                                        코드 개선 ────────┤
                                       GitHub PR ─────────┴──▶ 댓글 (PR 주소)
```

**SigNoz 는 이제 Node 한 곳으로만 쏩니다.** 예전에는 이 서비스와 별개로 Flow 릴레이
채널에도 같이 보냈지만, 그 채널은 제거했고 Flow 호출은 여기서 합니다 — 알럿을 한 번
정리한 뒤에 부르기 때문에 보드에 올라가는 것이 Alertmanager 페이로드가 아니라 장애
노트입니다.

- **어느 에이전트가 고칠지는 `AGENT_PROVIDER` 하나로 정합니다** (`claude` | `codex`).
  둘 다 이미지에 설치돼 있으므로 전환은 재빌드가 아니라 재시작입니다.
- **API 키를 쓰지 않는 것이 기본입니다.** 코드 수정은 로컬 로그인 세션으로 돕니다
  (Codex 는 원한다면 `OPENAI_API_KEY` 도 씁니다).
- **라벨 opt-in.** `autofix=true` 라벨(또는 `routes.yml` 항목)이 없는 알럿은 무시합니다.
  실수로 전체 알럿이 PR 을 만드는 일이 구조적으로 불가능합니다.
- **새 브랜치만 건드립니다.** base 브랜치에 커밋하지 않고, force-push 도 하지 않습니다.

---

## 준비물

- Docker 와 Docker Compose (또는 직접 실행할 Node 22+)
- 로그인된 에이전트 세션 하나 — Claude Code(`~/.claude`) 또는 Codex(`~/.codex`)
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

morningmate-alert 는 모델 API 를 직접 호출하지 않습니다. `claude` 또는 `codex` 실행 파일을
띄우고, 그 프로세스가 호스트에서 마운트한 로그인 세션을 씁니다.

```yaml
- ${HOME}/.claude:/home/app/.claude          # 읽기·쓰기
- ${HOME}/.claude.json:/home/app/.claude.json
- ${HOME}/.codex:/home/app/.codex            # 읽기·쓰기
```

**이 마운트는 반드시 쓰기 가능해야 합니다.** `:ro` 로 걸면 토큰을 갱신하기 전까지는
잘 돌다가, 갱신 시점부터 모든 작업이 원인을 알기 어려운 인증 오류로 실패합니다.
`/readyz` 가 `claude: false` 또는 `codex: false` 를 돌려주면 여기부터 확인하세요.

첫 `up` 전에 호스트에 디렉터리를 만들어 두세요. 없으면 Docker 가 root 소유로 만들어
에이전트가 쓰지 못합니다.

```bash
mkdir -p ~/.codex && chmod 700 ~/.codex
```

같은 이유로 `JOB_CONCURRENCY` 의 기본값은 **1** 입니다. 여러 에이전트 프로세스가 같은
자격 증명 파일을 동시에 갱신하면 세션이 깨질 수 있습니다.

### Codex 로그인

컨테이너 안에서 한 번만 하면 되고, 결과는 마운트된 `~/.codex/auth.json` 에 남아
재시작·재빌드를 넘겨 살아남습니다.

```bash
# ChatGPT 계정 (헤드리스 환경에서는 이 방식)
docker compose exec morningmate-alert codex login --device-auth

# 또는 API 키
printenv OPENAI_API_KEY | docker compose exec -T morningmate-alert codex login --with-api-key

# 확인
docker compose exec morningmate-alert codex login status
```

`.env` 의 `OPENAI_API_KEY` 를 채워도 됩니다. 비어 있으면 그 변수는 에이전트 환경에서
아예 제거되므로, 로그인 세션과 API 키가 섞여 어느 쪽이 쓰였는지 모르게 되는 일이 없습니다.

### Claude 와 Codex 의 격리 방식이 다릅니다

| | Claude Code | Codex |
|---|---|---|
| 셸 | `CLAUDE_DISALLOWED_TOOLS` 로 **차단** | 차단 불가 — 패치를 셸로 적용함 |
| 대신 쓰는 장치 | 도구 허용/차단 목록 | `CODEX_SANDBOX=workspace-write` (작업 트리 밖 쓰기·네트워크 차단) |
| 호스트 설정 유입 차단 | `--strict-mcp-config` | `--ignore-user-config` (`CODEX_IGNORE_USER_CONFIG`) |

Codex 는 셸을 쓸 수밖에 없으므로 **샌드박스가 유일한 경계**입니다.
`CODEX_SANDBOX=danger-full-access` 는 그 경계를 없앤다는 뜻이니 쓰지 마세요.

---

## SigNoz 연결

SigNoz 에서 **Settings → Account Settings → Notification Channels → New Channel** 로
가서 **Webhook** 을 고르고 다음을 채웁니다.

| 항목 | 값 |
|---|---|
| Webhook URL | `http://<호스트>:8080/v1/hooks/signoz` |
| Username | `SIGNOZ_WEBHOOK_USER` |
| Password | `SIGNOZ_WEBHOOK_PASS` |
| Send resolved alerts | **켜기** — 해소 알럿의 처리는 `SIGNOZ_ON_RESOLVED` 가 정합니다 |

API 로 등록할 수도 있습니다.

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

이 채널의 성질 셋이 설계를 그대로 결정했으니 알아 두면 좋습니다.

1. **인증이 Basic Auth 뿐입니다.** 커스텀 헤더를 못 붙입니다. `/v1/hooks/signoz` 만
   나머지 API 와 인증 방식이 다른 이유입니다.
2. **알럿이 묶여서 옵니다.** alertname 기준으로 그룹핑되어 기본 5분 간격으로 전송됩니다.
   훅은 `alerts[]` 를 순회하고 **항상 `200`** 을 돌려줍니다 — 4xx 를 주면 SigNoz 가
   배치 전체를 계속 재전송합니다.
3. **재전송이 정상 동작입니다.** 각 알럿의 `fingerprint` 를 멱등 키로 쓰기 때문에,
   계속 firing 인 알럿이라도 PR 은 하나만 열립니다.

### 웹훅이 실어 오는 것

본문은 Alertmanager v4 로 고정이고 **템플릿을 붙일 수 없습니다.** 보내는 쪽에서
움직일 수 있는 레버는 알럿 룰의 `labels` 와 `annotations` 둘뿐입니다. 실제로
도착하는 알럿 하나는 이렇게 생겼습니다.

```json
{
  "status": "firing",
  "labels": {
    "alertname": "디스크 사용률 초과 — 85% 경고 / 92% 위험",
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

라벨 키는 점을 그대로 유지합니다 — `service_name` 이 아니라 `service.name` 이고,
임계 티어 라벨은 `threshold.name` 입니다. `routes.yml` 의 `match` 도 이 철자를 씁니다.

수신부가 이걸 다루는 방식:

- **라벨을 전부 보존합니다.** 미리 정해 둔 몇 개만 고르지 않습니다. `threshold.name`
  (85%/92% 룰에서 실제로 넘은 쪽), `host.name`, `mountpoint` 처럼 아무도 예상해
  적어두지 않은 라벨이 대개 어느 계열이 아픈지를 말해 줍니다. `service.name` 만
  `service` 로 이름을 바꿔 담습니다 — 콘솔과 커밋 트레일러가 그 이름을 읽습니다.
- **`value` / `threshold` / `unit` 을 읽습니다.** 발송 시점에 렌더된 `{{$value}}`
  `{{$threshold}}` 로, 페이로드 안의 유일한 정량 사실입니다. 지시문에
  `Measured 87.4 percent against a threshold of 85 percent.` 한 줄로 들어갑니다.
- **모르는 어노테이션도 그대로 넘깁니다.** 위 여섯 키 밖의 것은 `From the alert
  rule:` 블록이 되어 에이전트에게 전달됩니다. 룰에 무엇을 더 적든 도착합니다.
- **원본을 통째로 남깁니다.** 잡의 `context._raw` 에 알럿 원문이 들어가고 콘솔이
  접어서 보여 줍니다. `_` 로 시작하는 키는 프롬프트와 PR 본문에서는 빠집니다.
- **배치를 로그에 한 번 찍습니다** (`SigNoz webhook received`). 무엇이 잡이 됐는지는
  나중에도 복원되지만, 무엇이 도착했는지는 여기 적어두지 않으면 사라집니다.
- **`endsAt` 의 `0001-01-01` 은 버립니다.** 아직 firing 중이라는 뜻이지 시각이 아닙니다.
  `externalURL` 도 `http://localhost:8080` 으로 오는 일이 있어, 그럴 때는 `SIGNOZ_URL`
  로 대체합니다.

그래서 룰에 아래 어노테이션을 넣어 두면 그대로 에이전트에게 도착합니다. 알럿 문구만
읽고 무엇을 측정했는지 추측하지 않아도 됩니다.

| 어노테이션 | 예 |
|---|---|
| `signal` | `traces` |
| `query` | `A: count() where has_error = true AND service.name IN (…) \| F1 = A / B * 100` |
| `group_by` | `service.name` |
| `window` | `5m 창 / 1m 주기` |
| `condition` | `critical: above 5 percent (all_the_times), 해소 2 percent` |

다섯 개 모두 룰 정의에서 그대로 뽑아낼 수 있으니, 룰을 고칠 때 같이 갱신하세요.

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

## 원인 분석 (SigNoz MCP)

6단계는 알럿 뒤의 텔레메트리에 닿을 수 있는 **유일한** 단계입니다. 에이전트를
**읽기 전용**으로 돌리고 SigNoz MCP 서버를 붙인 뒤, 요약 / 근거 / 영향 범위 /
수정 방향 / 확신도 다섯 절로 된 분석을 요구합니다. 실제로 돌린 쿼리와 읽은
`파일:줄` 을 근거로 달게 해서, 확인 불가능한 추정과 확인된 사실이 섞이지 않게 합니다.

이 보고서는 **파일을 하나도 고치기 전에** Flow 스레드에 올라갑니다. 그게 핵심입니다 —
브랜치가 아직 비어 있는 동안 사람이 진단에 반대할 수 있습니다. 코드 수정은 별도
실행으로 이어지고, 그 실행은 이 보고서를 '증명된 사실'이 아니라 '유력한 단서'로
받습니다.

```
SIGNOZ_URL=https://signoz.example.com    # MCP 컨테이너가 SigNoz 에 붙는 데 사용
SIGNOZ_API_KEY=…                         # 위와 동일. 에이전트에게는 전달되지 않음
SIGNOZ_MCP_URL=http://signoz-mcp:8080/mcp
```

MCP 서버는 프로필 뒤에 있어 그냥 `up` 으로는 뜨지 않습니다.

```bash
docker compose --profile signoz up -d
```

> **이 이미지의 기본 전송 방식은 stdio 입니다.** `TRANSPORT_MODE=http` (그리고 compose
> 네트워크에서 닿게 하려면 `MCP_SERVER_HOST=0.0.0.0`) 를 주지 않으면 컨테이너가 빈
> stdin 을 읽고 **종료 코드 0** 으로 끝납니다. 정상 종료라 "한 번 돌고 끝나는 작업"
> 처럼 보이지, 뜨지 못한 서버처럼 보이지 않는 게 함정입니다. `docker-compose.yml`
> 에 셋 다 넣어 뒀고, `/readyz` 가 `signozMcp` 를 따로 보고하므로 URL 오타와 죽은
> 컨테이너를 구분할 수 있습니다.

`SIGNOZ_MCP_URL` 을 비워 두는 것도 정상 동작입니다. 분석 단계가 저장소만 읽는 모드로
내려가고, 보고서에 그 사실을 명시합니다.

---

## 작업 11단계

| # | 단계 | 하는 일 |
|---|---|---|
| 1 | `queued` | 인증 · 라벨 게이트 · 허용 목록 · fingerprint 중복 확인 |
| 2 | `triaging` | 에이전트가 알럿 원문을 4절짜리 장애 노트로 정리 |
| 3 | `registering` | 그 노트로 Flow 업무를 등록하고 바로 *진행* 상태로 변경 |
| 4 | `preparing` | 미러 캐시 갱신 후 `git worktree` 생성 |
| 5 | `branching` | base 기준으로 `fix/<alertname>-<id>` 분기 |
| 6 | `analyzing` | SigNoz MCP + 소스를 읽기 전용으로 훑어 원인 분석, 결과를 댓글로 |
| 7 | `editing` | 그 분석을 들고 에이전트가 수정, 도구 호출을 실시간 중계 |
| 8 | `verifying` | `verify` 명령 실행, 실패 시 자가 수정 1회 |
| 9 | `committing` | identity 를 저장소 로컬 설정에 고정하고 커밋 |
| 10 | `pushing` | 새 브랜치로 일반 푸시 — `--force` 없음 |
| 11 | `pr_opened` | PR 생성 또는 갱신, PR 주소를 Flow 스레드에 댓글로 |

2 · 3 · 6 단계가 Flow 를 Node 뒤로 옮기면서 새로 생긴 단계입니다. 셋 다 실패하면
**작업을 죽이는 대신 기능만 내려갑니다** — 정리가 실패하면 알럿 원문이 그대로 업무
본문이 되고, Flow 가 안 되면 로그와 웹훅으로만 보고하고, 분석이 비면 알럿 내용만으로
고칩니다. 셋 중 어느 것도 '고치는 일' 자체를 막지 못합니다.

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
  "text": "[7/11] 코드 수정 — Edit src/notify/webhook.ts",
  "data": { "files": 2, "turns": 6 },
  "ts": "2026-08-21T02:14:33.812Z"
}
```

웹훅 전송에는 서명이 붙습니다 — `WEBHOOK_SECRET` 으로 원문 본문을 HMAC 한
`x-morningmate-alert-signature: sha256=<hmac>` 헤더입니다.

---

## Flow

Flow 에 들어가는 길이 셋이고, **서로 할 수 있는 일이 다릅니다.** 어느 쪽으로 돌고
있는지는 `/readyz` 가 알려 줍니다 — 다른 데서는 구분이 안 되기 때문입니다.

| | 업무 등록 | 진행 상태 변경 | 스레드 댓글 |
|---|---|---|---|
| 개인용 키 (`FLOW_API_SURFACE=user`) | ✅ | ✅ | ✅ |
| 관리자 키 (`FLOW_API_SURFACE=v1`) | ✅ | ✅ | ❌ → 웹훅 |
| 인커밍 웹훅만 | ✅ | ❌ | ❌ → 웹훅 |

두 REST 표면은 [api.flow.team/docs](https://api.flow.team/docs) 에 문서화돼 있습니다.
같은 경로에 접두어만 다른데, **한쪽 키로 다른 쪽을 부르면 401** 이 납니다. 키가
멀쩡한데 "API Key 정보가 올바르지 않습니다" 가 나오므로 부팅 때 미리 검사합니다.

```
POST  /{surface}/posts/projects/{projectId}/tasks                   업무 등록
PATCH /{surface}/posts/projects/{projectId}/tasks/{taskId}/status   업무 상태 수정
POST  /user/comments/{postId}                                       댓글 작성  ← user 전용
```

알아내는 데 시간이 걸린 것들:

- 인증은 **`x-flow-api-key` 헤더**입니다. Bearer 아닙니다.
- **모든 응답이 `response` 아래에 한 겹 더 싸여 있습니다** —
  `{"response":{"success":true,…}}`. 이걸 안 벗기면 성공한 등록이 "ID 가 없는 응답"
  으로 보입니다.
- **`/v1` 에는 댓글 API 가 아예 없습니다.** `/v1/comments/{postId}` 도
  `/v1/posts/{postId}/comments` 도 404 입니다. 댓글은 개인용 표면에만 있습니다.
- **`registerId` 는 이메일이 아니라 userId 입니다.** `/v2/employees` 가 둘 다
  돌려주고 문서 예시는 주소 형태라 헷갈리는데, 주소를 넣으면 412
  "…은(는) 유효하지 않은 작성자입니다" 가 나서 권한 문제처럼 읽힙니다.
  `/v1` 은 **상태 변경에도** 이 값을 요구합니다.
- `createTask` 는 `taskId` 와 `postId` 를 **둘 다** 돌려줍니다. 상태는 task 를,
  댓글은 post 를 가리킵니다. 바꿔 쓸 수 없습니다.
- 지금과 같은 상태로 바꾸면 400 입니다. 정상 경로에서도 나오므로 삼킵니다.

```
FLOW_API_BASE=https://api.flow.team
FLOW_API_KEY=…
FLOW_API_SURFACE=v1                  # user | v1
FLOW_REGISTER_ID=…                   # v1 전용. 이메일 아님, userId
FLOW_PROJECT_ID=…
FLOW_STATUS_NEW=request              # request | progress | feedback | complete | hold
FLOW_STATUS_RUNNING=progress
FLOW_STATUS_DONE=complete
FLOW_STATUS_FAILED=feedback
FLOW_COMMENT_STAGES=analyzing,pr_opened,final
```

### 업무에 실리는 내용

등록되는 업무와 뒤따르는 댓글은 셋을 합쳐 하나의 사고 보고서가 됩니다.

| 어디에 | 무엇이 |
|---|---|
| 업무 본문 (정리 단계) | **어디서** 서비스·환경·실패한 라우트/잡·시각 · **누가/무엇이** 무엇이 촉발했고 몇 건이 영향받았나 · **무엇이** 증상과 측정값 대 임계치, 예외 타입 · **왜** 메커니즘과 의심 코드 경로 · **확인할 것** |
| 원인 분석 댓글 | **어디서**(`파일:줄`) · **누가/무엇이** · **왜**(단계별 메커니즘) · **근거**(실제 쿼리·트레이스·읽은 줄) · **영향 범위** · **수정 방향** · **확신도** |
| PR 댓글 | **원인** 한 줄 요약 · **수정 내용**(에이전트가 직접 쓴 설명) · **변경 파일** · diffstat · **PR 링크** |

업무 제목은 `<알럿명> — <레포>` 입니다. 접두어는 붙이지 않습니다 — 어차피 그 프로젝트에
올라오는 업무는 전부 여기서 만든 것이라, 접두어는 제목 200자만 깎아먹었습니다.

**본문과 댓글은 전부 평문(plain text)입니다.** Flow 는 Markdown 도 HTML 도 렌더링하지
않아서 `**굵게**` 는 별표 두 개로, ``` 펜스는 백틱 세 개로 그대로 보입니다. 그래서 위
표의 소제목들은 실제로는 `■ 어디서` 처럼 나가고, 정리·원인 분석 프롬프트도 평문을
쓰라고 명시합니다. 구분선은 `---` 대신 가로줄 문자(─)입니다. GitHub PR 본문은 예외로
Markdown 그대로입니다 — 거기는 렌더링이 되니까요.

정리 단계가 SigNoz 를 조회하는 이유가 이것입니다(`TRIAGE_USE_SIGNOZ_MCP=true`).
알럿 본문만으로는 "어디서 / 누가 / 왜" 를 채울 수 없어서, 끄면 업무 본문이
"확인되지 않음" 투성이가 됩니다. 대신 프롬프트가 **모르는 것은 지어내지 말고
"확인되지 않음" 이라고 쓰라**고 강제하므로, 빈칸은 게으름이 아니라 실제로 텔레메트리에
없다는 뜻입니다.

---

### 인커밍 웹훅

웹훅 엔드포인트(개발자 포털 → 웹훅 관리)는 봇·Action·대상 프로젝트를 이미 고정하고
있어서, 보내는 건 `{title, text}` 와 `x-flow-webhook-token` 헤더뿐입니다. 응답은
`{"response":{"success":true,"code":200,"message":"success"}}` — **ID 가 없습니다.**
그래서 항목을 만드는 것 말고는 아무것도 못 합니다. 엔드포인트당 분당 60건.

```
FLOW_WEBHOOK_URL=…            FLOW_WEBHOOK_TOKEN=…            # default 엔드포인트
FLOW_WEBHOOK_BILLING_URL=…    FLOW_WEBHOOK_BILLING_TOKEN=…    # FLOW_WEBHOOK_<NAME>_*
```

댓글을 못 쓰는 모드에서는 업데이트가 알럿명과 작업 ID 를 제목에 단 **별도 항목**
으로 올라갑니다. 찾을 수는 있게 하되 스레드는 아니고, 개인용 키를 넣으면 진짜
댓글이 됩니다.

### 알럿마다 다른 프로젝트로 보내기

Node 가 넘겨받기 전에는 `signoz-flow-relay` 가 알럿의 `team` 라벨을 보고 release ·
billing 을 각각 다른 방으로 갈랐습니다. 그 분기는 이제 `routes.yml` 에 있고, v1 키
에서는 **둘 다** 필요합니다 — 업무가 등록될 프로젝트, 업데이트가 올라갈 웹훅:

```yaml
  - match: { team: billing }
    repo: madrascheck-dev/morningmate-payment
    flowProjectId: "2954511"     # [Production] Morningmate Billing Signoz
    flowWebhook: billing         # FLOW_WEBHOOK_BILLING_URL
    dryRun: true
```

비워 두면 모든 알럿이 `FLOW_PROJECT_ID` 와 `default` 웹훅 한 곳으로 모입니다.
릴레이를 그냥 떼면 잃는 유일한 동작이 이것입니다.

---

## 빌링 알럿과 Stripe MCP

실패한 결제의 진실은 트레이스가 아니라 Stripe 에 있습니다. 로그는 "결제가 실패했다"
까지만 말하고, **왜** 실패했는지(거절 코드, 재시도 여부, 웹훅이 우리에게 도달했는지,
한 고객인지 전부인지)는 Stripe 쪽 객체를 읽어야 나옵니다. 그래서 빌링 라우트는
SigNoz 외에 Stripe MCP 서버를 하나 더 엽니다.

```yaml
  - match: { service.name: tokyo-billing-production }
    repo: madrascheck-dev/morningmate-payment
    flowProjectId: "2954511"
    flowWebhook: billing
    mcp: [stripe]                # SigNoz 는 항상 열려 있음. 여기엔 "그 외" 만
```

`mcp` 는 3·6·7단계(정리 · 원인 분석 · 수정)에 그대로 전달됩니다. 알럿 룰에
`mcp: stripe` 라벨을 달면 라우트보다 그 라벨이 이깁니다.

켜는 법은 `.env` 에 키 한 줄입니다:

```bash
STRIPE_MCP_URL=https://mcp.stripe.com
STRIPE_MCP_KEY=rk_live_...        # 읽기 전용 restricted key
```

Stripe 원격 MCP 서버는 API 키를 bearer 로 받기 때문에 브라우저 없는 컨테이너에서도
씁니다(문서가 먼저 안내하는 OAuth 는 헤드리스에서 못 씁니다). 키는 **반드시 읽기
전용 restricted key** 로 발급하세요 — 에이전트는 셸을 갖고 있고, 조사에 필요한 권한은
읽기뿐입니다. Codex 드라이버는 토큰을 argv 가 아니라 `bearer_token_env_var` 로 넘기고,
Stripe 를 받지 않은 잡의 환경에서는 키를 지웁니다.

`STRIPE_MCP_KEY` 가 비어 있으면 경고 한 줄만 남기고 Stripe 없이 돕니다 — 조사 품질이
내려갈 뿐 잡은 죽지 않습니다. `/readyz` 의 `stripeMcp` 가 어느 쪽인지 알려줍니다.

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
| `SIGNOZ_MCP_URL` | — | 비면 원인 분석이 저장소만 읽는 모드로 내려감 |
| `STRIPE_MCP_URL` | `https://mcp.stripe.com` | 빌링 라우트(`mcp: [stripe]`)에만 열림 |
| `STRIPE_MCP_KEY` | — | **읽기 전용 restricted key**. 비면 Stripe 없이 조사 |
| `TRIAGE_ENABLED` | `true` | 끄면 알럿 원문이 그대로 Flow 업무 본문이 됨 |
| `TRIAGE_TIMEOUT_MS` | `180000` | 이게 끝날 때까지 보드가 비어 있으므로 짧게 |
| `TRIAGE_USE_SIGNOZ_MCP` | `false` | 정리는 빠르게. 원인 분석은 항상 MCP 사용 |
| `ANALYSIS_ENABLED` | `true` | 끄면 알럿 내용만으로 수정 |
| `ANALYSIS_TIMEOUT_MS` | `600000` | |
| `FLOW_API_KEY` | — | `x-flow-api-key`. 비면 Flow 연동 꺼짐 |
| `FLOW_API_SURFACE` | `user` | `user`(개인용 키) 또는 `v1`(관리자 키). 안 맞으면 401 |
| `FLOW_REGISTER_ID` | — | v1 전용. 이메일이 아니라 **userId** |
| `FLOW_WEBHOOK_URL` / `_TOKEN` | — | `default` 인커밍 웹훅 |
| `FLOW_PROJECT_ID` | — | 기본 프로젝트. `routes.yml` 에서 알럿별로 덮어쓸 수 있음 |
| `FLOW_STATUS_RUNNING` | `progress` | 작업이 시작될 때 옮겨 갈 상태 |
| `FLOW_COMMENT_STAGES` | `registering,analyzing,editing,verifying,pr_opened,final` | 댓글로 남길 단계 |
| `ALLOWED_REPOS` | `sjsh1623/*` | 허용 저장소 글롭 |
| `GIT_AUTHOR_EMAIL` | `sjsh1623@flow.team` | 저장소별로 고정됨 |
| `AGENT_PROVIDER` | `claude` | `claude` 또는 `codex`. 어느 에이전트가 코드를 고칠지 |
| `CLAUDE_MODEL` | `claude-opus-5` | |
| `CLAUDE_DISALLOWED_TOOLS` | `Bash,WebFetch,WebSearch,Task` | 에이전트를 셸에서 떼어 놓는 장치 |
| `CODEX_MODEL` | — | 비워두면 Codex 기본 모델 |
| `CODEX_SANDBOX` | `workspace-write` | Codex 의 유일한 경계. `danger-full-access` 는 쓰지 말 것 |
| `CODEX_IGNORE_USER_CONFIG` | `true` | 마운트한 호스트 `~/.codex/config.toml` 을 무시 |
| `OPENAI_API_KEY` | — | 비우면 로그인 세션 사용. 비었을 때는 환경에서 제거됨 |
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
  jobs/              store.ts (SQLite) · queue.ts · lifecycle.ts (11단계)
  workspace/         mirror.ts (베어 캐시) · worktree.ts
  agent/             claude.ts (헤드리스 실행) · stream.ts (NDJSON) · prompt.ts
  git/               credentials.ts · identity.ts · commit.ts · push.ts
  forge/             github.ts (Octokit)
  notify/            bus.ts · render.ts · transports/{flow,webhook,sse}.ts
  i18n/              index.ts · locales/{ko,en}.json
  console/           index.html · console.js
```
