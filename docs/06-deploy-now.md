# 06. 지금부터 할 일 — 실행 플레이북

이 문서는 **현재 계정 상황에 맞춘 작업 순서**입니다.
일반적인 절차는 [02-aws-console-setup.md](./02-aws-console-setup.md)를 보세요.

---

## 현재 상태

| 항목 | 상태 |
|---|---|
| AWS 계정 / IAM 사용자 `kosa35` / 리전 `us-east-1` | ✅ |
| Bedrock 모델 액세스 (Claude Sonnet 4.6) | ✅ |
| Lambda 함수 `bookbot-api` | ⚠️ 생성됨 (코드가 구버전) |
| SSM 파라미터 (도서 API 키) | ✅ |
| **로컬 AWS CLI** | ❌ MFA 강제 정책에 차단됨 |
| DynamoDB 테이블 | ❌ |
| IAM 실행 역할 / 정책 | ❓ 확인 필요 |
| S3 버킷 (프론트엔드) | ❌ |
| CloudFront 배포 | ❌ |
| WAF / 알람 / 예산 | ❌ |

### 왜 로컬 CLI가 안 되는가

계정에 `kosa-edu-mfa-pol` 정책이 붙어 있어 **MFA 인증되지 않은 요청을 전부 거부**합니다.
등록된 MFA는 FIDO 보안 키(`u2f/...`) 하나뿐인데, FIDO는 6자리 코드를 만들지 않고
AWS CLI는 WebAuthn을 지원하지 않아 `sts:GetSessionToken`으로 MFA 세션을 받을 수 없습니다.

**→ 콘솔 세션을 그대로 쓰는 AWS CloudShell로 우회합니다.**

---

# 경로 선택

| | 경로 A — CloudShell | 경로 B — 콘솔 수동 |
|---|---|---|
| 소요 시간 | **15~25분** | 2~3시간 |
| MFA 문제 | 우회됨 | 해당 없음 |
| 학습 효과 | 낮음 (자동화) | 높음 (각 설정의 의미를 익힘) |
| 실패 시 복구 | 재실행하면 됨 (idempotent) | 수동 추적 |

**추천: 먼저 경로 A로 동작하는 걸 확인하고, 그다음 콘솔에서 각 리소스를 열어보며 이해하기.**
이미 만들어진 리소스를 콘솔에서 읽는 게, 처음부터 만드는 것보다 학습 효율이 좋습니다.

경로 A가 막히면 경로 B로 가면 됩니다. 아래 두 경로를 모두 적었습니다.

---

# 경로 A — CloudShell 자동 배포

## STEP A-1. Lambda 코드를 최신으로 교체 (먼저 하세요)

지금 올라간 코드에는 이후 수정분이 빠져 있습니다:

- 헬스체크 진단 강화 (DynamoDB 실제 접근 테스트, SSM 실패 원인, 모델 ID 형식 분석, `problems` 배열)
- Gutendex `/books` → `/books/` 수정 (301 리다이렉트 제거) + 미러 페일오버
- Gutendex 장애 시 Open Library 무료전문 자동 폴백
- 모델 ID 오탐 수정 (4.6 세대의 접미사 없는 ID를 유효로 인정)

1. Lambda 콘솔 → `bookbot-api` → **코드** 탭
2. **업로드 원본** → **.zip 파일**
3. `/Users/phontom/Desktop/0827/backend/dist/bookbot-backend.zip` (1.7MB) 선택 → 저장
4. 같은 화면 아래 **런타임 설정** → **편집** → 핸들러가 **`src/index.handler`** 인지 확인

> 이 단계를 CloudShell에서 해도 되지만(A-5에서 자동 처리됨), 지금 해두면
> 다음 단계에서 헬스체크로 상태를 정확히 볼 수 있어 디버깅이 쉽습니다.

## STEP A-2. 헬스체크로 현재 상태 확인

Lambda 콘솔 → **테스트** 탭 → 이벤트 이름 `health` → JSON을 아래로 교체 → 저장 → 테스트

```json
{
  "version": "2.0",
  "rawPath": "/api/health",
  "requestContext": { "http": { "method": "GET", "sourceIp": "127.0.0.1" } },
  "headers": {},
  "isBase64Encoded": false
}
```

응답이 두 덩어리로 붙어 나오는 건 정상입니다 (스트리밍 메타데이터 + 본문).

**`problems` 배열만 보세요.** 지금 예상되는 항목:

```
"DynamoDB 접근 실패 (ResourceNotFoundException): 테이블 "bookbot"이 리전 us-east-1에 없습니다..."
```

`secrets`의 두 키가 `true`로 나오면 SSM 등록이 잘 된 것입니다.
`false`면 IAM 실행 역할에 SSM/KMS 권한이 없거나 파라미터 경로가 다릅니다
(A-5에서 스크립트가 올바른 역할을 만들어 붙이므로 자동으로 해결됩니다).

## STEP A-3. CloudShell 열고 번들 업로드

1. AWS 콘솔 우측 상단 **터미널 아이콘 (`>_`)** 클릭
2. **리전이 `us-east-1`(N. Virginia)** 인지 확인 — CloudShell은 현재 콘솔 리전에서 실행됩니다
3. 초기화 대기 (30초~1분)
4. 우측 상단 **Actions** → **Upload file**
5. `/Users/phontom/Desktop/0827/bookbot-cloudshell.zip` (216KB) 선택

## STEP A-4. 압축 해제 및 환경 확인

```bash
unzip -q bookbot-cloudshell.zip -d bookbot && cd bookbot
ls infra/
```

Node.js 버전 확인 (Lambda 런타임과 맞춰 22 이상 필요):

```bash
node --version
```

22 미만이면 nvm으로 설치 (CloudShell 홈은 유지되므로 한 번만 하면 됩니다):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 22 && nvm use 22
node --version
```

자격증명 확인 (CloudShell은 콘솔 세션을 물려받으므로 MFA 인증된 상태입니다):

```bash
aws sts get-caller-identity
```

## STEP A-5. 비밀 값 설정

```bash
cp infra/secrets.env.example infra/secrets.env
nano infra/secrets.env
```

채울 값:

```
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6
GOOGLE_BOOKS_API_KEY=
HARDCOVER_TOKEN=
ALERT_EMAIL=본인이메일@example.com
CONTACT_EMAIL=본인이메일@example.com
```

저장: `Ctrl+O` → `Enter` → `Ctrl+X`

**중요한 두 가지:**

- **`BEDROCK_MODEL_ID`에 `us.` 접두사를 붙이는 걸 권합니다.**
  지금 Lambda에 넣은 `anthropic.claude-sonnet-4-6`도 유효하지만 In-Region 추론이라
  온디맨드 쿼터가 가장 낮습니다. 데모 중 `ThrottlingException`이 날 수 있습니다.
  `us.` 를 붙이면 Geo 추론이 되어 쿼터가 넉넉해집니다.

- **도서 API 키는 비워둬도 됩니다.**
  이미 SSM에 등록하셨다면, 스크립트는 빈 값을 건너뛰고 **기존 SSM 값을 그대로 유지**합니다
  (`01-backend.sh`의 `put_param`이 빈 값이면 return). 덮어쓸 걱정 없습니다.

## STEP A-6. 배포

```bash
bash infra/go.sh
```

진행 순서:

```
1/5  AWS 로그인          이미 인증됨 → 통과
2/5  Bedrock 모델        secrets.env에 지정했으므로 그대로 사용
3/5  사전 점검           권한 8종 + 도서 API 키 + 리전 불일치
4/5  배포
       01-backend    DynamoDB+TTL → SSM → IAM 정책/역할 → Lambda 갱신
                     → 예약동시성 10 → 로그보존 14일 → Function URL
       02-frontend   S3 버킷(비공개) → Vite 빌드 → 캐시헤더 분리 업로드
       03-cloudfront OAC 2개 → 배포(오리진2 + /api/*) → 버킷정책
                     → Lambda 리소스정책 → 무효화
       04-guardrails WAF(레이트2규칙) → SNS → 알람4개 → 예산2개
5/5  검증               전파 대기 → 헬스체크 → 실제 채팅 → 보안 → 레이트리밋
```

**기존 Lambda와 SSM은 새로 만들지 않고 갱신만 합니다** (전부 idempotent).

CloudFront 전파에 5~15분 걸리므로 5/5 단계에서 기다립니다. 중간에 끊겨도 괜찮습니다:

```bash
bash infra/verify.sh     # 검증만 다시
```

## STEP A-7. 결과 확인

배포가 끝나면 서비스 URL이 출력됩니다:

```
서비스 URL
  https://dxxxxxxxxxx.cloudfront.net
```

브라우저로 열어서 확인할 것:

| 확인 | 기대 동작 |
|---|---|
| 첫 화면 | 챗봇 UI + 예시 질문 칩 5개 |
| 예시 질문 클릭 | "4개 도서 DB 통합 검색" 진행 표시 → 책 카드 → 답변 텍스트 |
| 답변 방식 | 한 번에 나오지 않고 조각조각 나옴 (스트리밍) |
| 책 카드 | 표지 · 평점 · 장르 · 무드 태그 |
| "무료 고전 추천해줘" | 카드에 EPUB/TXT 다운로드 버튼 |
| 후속 질문 | 이전 추천을 기억 (DynamoDB 세션) |

## STEP A-8. SNS 구독 확인 (잊기 쉬움)

`ALERT_EMAIL`을 넣었다면 AWS SNS에서 확인 메일이 옵니다.
**"Confirm subscription" 링크를 클릭**해야 알람 메일이 실제로 옵니다.

---

# 경로 B — 콘솔 수동 배포 (경로 A가 막혔을 때)

이미 Lambda와 SSM은 끝났으니 남은 것만 하면 됩니다.
각 단계의 상세 설정값은 [02-aws-console-setup.md](./02-aws-console-setup.md)를 보세요.

| 순서 | 작업 | 상세 |
|---|---|---|
| B-1 | Lambda 코드 최신 zip 교체 + 핸들러 확인 | STEP 6-C, 6-D |
| B-2 | **DynamoDB 테이블 `bookbot` + TTL(`ttl`)** | STEP 4 |
| B-3 | IAM 정책/역할 확인 — Bedrock·DynamoDB·SSM·KMS 권한 | STEP 5 |
| B-4 | Lambda 일반 구성 (메모리 1024, 타임아웃 90초) | STEP 6-E |
| B-5 | Lambda 예약 동시성 = 10 | STEP 6-G |
| B-6 | Function URL (AWS_IAM + RESPONSE_STREAM) | STEP 7 |
| B-7 | S3 버킷 (퍼블릭 차단 유지) | STEP 8 |
| B-8 | 프론트 빌드 후 `dist` **내용물** 업로드 | STEP 11 |
| B-9 | CloudFront + S3 OAC + 버킷 정책 + 오류페이지 | STEP 9 |
| B-10 | `/api/*` 동작 + Lambda OAC + 리소스 정책 | STEP 10 |
| B-11 | WAF | STEP 12 |
| B-12 | 알람 + 예산 | STEP 13, STEP 0 |

프론트엔드 빌드는 로컬에서 하면 됩니다 (AWS 권한 불필요):

```bash
cd /Users/phontom/Desktop/0827/frontend
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm install && npm run build
# → frontend/dist/ 안의 내용물을 S3 버킷 루트에 업로드
```

**B-10이 가장 까다롭습니다.** 세 가지를 놓치면 안 됩니다:
- `/api/*` 동작의 캐시 정책 = **CachingDisabled** (아니면 모든 사용자가 첫 답변을 받습니다)
- 원본 요청 정책 = **AllViewerExceptHostHeader** (`AllViewer`면 SigV4 서명이 깨져 403)
- 압축 자동 개설 = **아니요** (SSE 스트리밍이 버퍼링됩니다)

그리고 Lambda 리소스 정책의 Action은 `lambda:InvokeFunction`이 아니라
**`lambda:InvokeFunctionUrl`** 입니다.

---

# 공통 — 배포 후 확인

CloudShell 또는 로컬(CloudFront 경유는 인증 불필요)에서:

```bash
SITE=https://dxxxxxxxxxx.cloudfront.net

curl -s $SITE/api/health | python3 -m json.tool

curl -N -X POST $SITE/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"잔잔하게 위로되는 소설 추천해줘"}'
```

`problems: []` 이면 설정 완료입니다.

`curl -N`에서 응답이 **한 번에 쏟아지면** 스트리밍이 안 되는 것입니다.
[02-aws-console-setup.md STEP 10의 "플랜 B"](./02-aws-console-setup.md)를 보세요.
핸들러를 `src/index.bufferedHandler`로 바꾸면 타이핑 효과만 없어지고 나머지는 동작합니다
(프론트가 두 형식을 모두 처리하므로 프론트 수정 불필요).

보안 확인 — 둘 다 **403이 나와야** 정상입니다:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<버킷>.s3.us-east-1.amazonaws.com/index.html
curl -s -o /dev/null -w '%{http_code}\n' https://<함수URL>
```

---

# 운영 (2주간)

## 매일 2분

1. [Cost Explorer](https://console.aws.amazon.com/costmanagement/home#/cost-explorer) — Bedrock 막대가 튀는 날이 있나
2. CloudWatch 알람 4개가 전부 OK인가
3. 서비스에 한 번 접속해서 대화해보기

## 주 1회

CloudWatch → Logs Insights → `/aws/lambda/bookbot-api`:

```
fields inputTokens, outputTokens, totalMs
| filter msg = "chat 완료"
| stats count(*) as 요청수, sum(inputTokens) as 입력토큰,
        sum(outputTokens) as 출력토큰, avg(totalMs)/1000 as 평균초
```

토큰 수에 단가를 곱하면 실제 비용이 나옵니다 (Sonnet 4.6 기준 입력 $3 / 출력 $15 per 1M).

## 비용이 튈 때 긴급 정지

Lambda → 구성 → 동시성 → **예약된 동시성 `0`** → 저장.
즉시 모든 호출이 차단되고, 값을 되돌리면 복구됩니다.

## 품질 개선

`backend/src/prompt.mjs`를 고치는 것이 추천 품질에 가장 큰 영향을 줍니다.
수정 후 CloudShell에서:

```bash
bash infra/01-backend.sh
```

## 비용 절감 — 프롬프트 캐싱 (Sonnet 4.6 지원)

입력 8,100 토큰 중 시스템 프롬프트 + 도구 스펙 약 2,700 토큰이 매 요청마다 동일합니다.
`backend/src/agent.mjs`의 `system` 배열에 캐시 지점을 추가하면 최대 90% 절감됩니다:

```js
system: [
  { text: SYSTEM_PROMPT },
  { cachePoint: { type: 'default' } },
],
```

Sonnet 4.6은 최소 1,024 토큰 / 체크포인트 4개 / TTL 5분·1시간을 지원합니다.

---

# 2주 후 — 반드시 정리

```bash
# CloudShell에서
cd bookbot && bash infra/destroy.sh
```

의존 순서대로 삭제합니다 (WAF 연결해제 → CloudFront 비활성화 → 삭제 → ... → 예산).
CloudFront 비활성화 전파 때문에 15~25분 걸립니다.

콘솔로 지우실 경우 [04-cost-and-cleanup.md 6절](./04-cost-and-cleanup.md)의 순서를 지키세요.
특히 **CloudWatch 로그 그룹**과 **SSM 파라미터(API 키)**를 잊지 마세요.

정리 후 **다음날** Cost Explorer를 한 번 더 확인하세요 (요금 반영이 최대 24시간 지연).

Google Cloud와 Hardcover에서도 API 키를 폐기하는 것을 권합니다.

---

# 막혔을 때

| 증상 | 문서 |
|---|---|
| Bedrock 오류 (AccessDenied / Validation / Throttling) | [05-runbook.md 3-4](./05-runbook.md) |
| CloudFront 403 / 502 / 504 | [05-runbook.md 3-2](./05-runbook.md) |
| 스트리밍이 안 됨 | [05-runbook.md 3-5](./05-runbook.md) |
| 도서 API 실패 | [05-runbook.md 3-7](./05-runbook.md) |
| 추천 품질 문제 | [05-runbook.md 3-8](./05-runbook.md) |

로그 실시간 확인 (CloudShell):
```bash
aws logs tail /aws/lambda/bookbot-api --region us-east-1 --follow --format short
```

오류만:
```bash
aws logs tail /aws/lambda/bookbot-api --region us-east-1 --since 1h \
  --filter-pattern '"level":"error"'
```
