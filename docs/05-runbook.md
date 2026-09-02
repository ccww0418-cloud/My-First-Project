# 05. 운영 런북

배포 후 실제로 손을 대는 작업들을 모았습니다.

## 목차
1. [코드 수정 후 재배포](#1-코드-수정-후-재배포)
2. [설정만 바꾸기 (재배포 불필요)](#2-설정만-바꾸기-재배포-불필요)
3. [증상별 트러블슈팅](#3-증상별-트러블슈팅)
4. [모니터링 루틴](#4-모니터링-루틴)
5. [로컬 개발 환경](#5-로컬-개발-환경)
6. [롤백](#6-롤백)
7. [답변 평가 읽기](#7-답변-평가-읽기)
8. [읽을 목록 운영 메모](#8-읽을-목록-운영-메모)
9. [회귀 테스트 모음](#9-회귀-테스트-모음)
10. [원샷 배포](#10-원샷-배포-infraoneshotsh)

---

# 1. 코드 수정 후 재배포

## 1-1. 백엔드 (Lambda)

```bash
cd backend
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # Homebrew node@22를 쓰는 경우

# ① 문법 검사 (30초)
for f in $(find src -name '*.mjs'); do node --check "$f" || echo "FAIL: $f"; done

# ② 외부 API 연결 확인 (1분) — AWS에 올리기 전에 여기서 잡는 게 훨씬 빠릅니다
export GOOGLE_BOOKS_API_KEY="AIza..."
export HARDCOVER_TOKEN="eyJ..."
npm run smoke

# ③ 패키징
bash scripts/build.sh     # → dist/bookbot-backend.zip
```

**콘솔로 업로드:**
Lambda → `bookbot-api` → 코드 탭 → **업로드 원본** → **.zip 파일** → 선택 → 저장

**CLI로 업로드 (훨씬 빠릅니다):**
```bash
aws lambda update-function-code \
  --function-name bookbot-api \
  --zip-file fileb://dist/bookbot-backend.zip \
  --region ap-northeast-2 \
  --no-cli-pager

# 배포 완료 대기
aws lambda wait function-updated \
  --function-name bookbot-api --region ap-northeast-2

# 헬스체크로 확인
curl -s https://<배포도메인>/api/health | python3 -m json.tool
```

> CloudFront 무효화는 **불필요**합니다. `/api/*` 동작은 `CachingDisabled`라
> 항상 오리진(Lambda)으로 갑니다.

## 1-2. 프론트엔드 (S3 + CloudFront)

```bash
cd frontend
npm run build
```

**콘솔:**
1. S3 → 버킷 → **업로드** → `dist/` **안의 내용물**을 드래그 (dist 폴더 자체가 아님)
2. CloudFront → 배포 → **무효화** 탭 → **무효화 생성** → 경로 `/*`

**CLI:**
```bash
BUCKET=bookbot-web-20260827
DIST_ID=<배포ID>

# 해시가 붙은 asset은 영구 캐싱, index.html은 캐싱 금지
aws s3 sync dist/ s3://$BUCKET/ --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html"

aws s3 cp dist/index.html s3://$BUCKET/index.html \
  --cache-control "no-cache"

aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*"
```

## 1-3. 프롬프트만 수정할 때

`backend/src/prompt.mjs`를 고치는 게 **가장 자주 하게 될 작업**입니다.
추천 품질은 코드보다 프롬프트에서 결정됩니다.

프론트 재배포 없이 백엔드만 올리면 됩니다 (1-1).
`SUGGESTIONS` 배열(예시 질문)도 여기 있어서, 백엔드만 갱신하면
프론트 화면의 예시 칩이 바뀝니다.

---

# 2. 설정만 바꾸기 (재배포 불필요)

Lambda → `bookbot-api` → **구성** → **환경 변수** → 편집 → 저장.
**즉시 반영됩니다** (다음 콜드 스타트부터, 보통 수 초).

| 하고 싶은 일 | 바꿀 변수 | 값 |
|---|---|---|
| 비용을 줄이고 싶다 | `BEDROCK_MODEL_ID` | Haiku 계열 추론 프로필 ID |
| 답변 품질을 올리고 싶다 | `BEDROCK_MODEL_ID` | Sonnet 계열 |
| 답변이 너무 짧다 | `BEDROCK_MAX_TOKENS` | `3072` |
| 답변이 매번 달라서 불안정하다 | `BEDROCK_TEMPERATURE` | `0.2` |
| 답변이 뻔하다 | `BEDROCK_TEMPERATURE` | `0.7` |
| 트래픽이 몰려서 비용이 걱정된다 | `RATE_LIMIT_PER_DAY` | `30` |
| 검색 반복을 줄여 비용 절감 | `MAX_TOOL_ITERATIONS` | `2` |
| 외부 API가 느려서 타임아웃 | `EXTERNAL_API_TIMEOUT_MS` | `9000` |
| gutendex가 계속 느리다 | `GUTENDEX_TIMEOUT_MS` | `2500` |
| gutendex 미러를 알게 됐다 | `GUTENDEX_BASE_URLS` | `https://gutendex.com,https://미러주소` |
| 문제를 파헤쳐야 한다 | `LOG_LEVEL` | `debug` (**끝나면 `info`로 되돌리세요 — 로그 요금**) |
| 캐시를 더 오래 쓰고 싶다 | `CACHE_TTL_SECONDS` | `86400` (24시간) |

## API 키 교체 (재배포 불필요)

Systems Manager → Parameter Store → 파라미터 선택 → **편집** → 값 변경 → 저장.

> 코드가 SSM 값을 **5분간 캐싱**합니다. 즉시 반영하려면 Lambda 환경 변수를
> 아무거나 하나 저장(값이 같아도 됨)해서 실행 환경을 교체하세요.

---

# 3. 증상별 트러블슈팅

## 3-1. 진단 순서 (막혔을 때 이 순서로)

```
① curl https://<배포도메인>/api/health
   ├─ 403/404          → CloudFront 설정 문제      → 3-2로
   ├─ 502/504          → Lambda 오리진 문제        → 3-3으로
   ├─ ok:true, secrets가 false → SSM/IAM 문제      → 3-4로
   └─ 정상             → ②로

② curl -N -X POST .../api/chat -d '{"message":"테스트"}'
   ├─ 아무 응답 없음    → Lambda 실행 오류         → CloudWatch 로그 확인
   ├─ type:error       → 메시지 내용을 읽으세요 (Bedrock 진단 힌트가 담겨 있습니다)
   ├─ 한꺼번에 쏟아짐   → 스트리밍 설정 문제        → 3-5로
   └─ 정상             → ③으로

③ 브라우저에서 확인
   ├─ 화면이 안 뜸      → S3 업로드/버킷 정책      → 3-6으로
   └─ 화면은 뜨는데 응답 없음 → 개발자도구 네트워크 탭 확인
```

## 3-2. CloudFront 관련

| 증상 | 원인 | 해결 |
|---|---|---|
| `/api/health`가 HTML(프론트)을 반환 | `/api/*` 동작이 없거나 Default 아래에 있음 | 동작 탭에서 `/api/*`를 Default보다 위로 |
| 403 `Missing Authentication Token` | Lambda 리소스 정책 누락 | [STEP 10-C](./02-aws-console-setup.md) 재확인. Action이 `lambda:InvokeFunctionUrl`인지 |
| 403 (서명/SigV4 관련 메시지) | 원본 요청 정책이 `AllViewer` | `AllViewerExceptHostHeader`로 변경 |
| 502 Bad Gateway | 오리진 도메인에 `https://` 또는 끝 `/` 포함 | 호스트명만 남기기 |
| 504 Gateway Timeout | 오리진 응답 시간 초과 30초 | 오리진 편집 → `60`초 |
| 항상 같은 답변 | 캐시 정책이 `CachingOptimized` | `CachingDisabled`로 |
| 루트 접속 시 AccessDenied | 기본값 루트 객체 미설정 | 배포 설정 → `index.html` |

**CloudFront 설정을 바꿨는데 반영이 안 되는 것 같으면** — 전파에 5~15분 걸립니다.
배포 상세의 **마지막으로 수정된 날짜**가 "배포 중"이 아닌지 확인하세요.

## 3-3. Lambda 관련

먼저 로그를 봅니다: Lambda → 모니터링 → **CloudWatch 로그 보기**

| 로그 메시지 | 원인 | 해결 |
|---|---|---|
| `Cannot find module 'src/index'` | 핸들러 값 오류 | 런타임 설정 → `src/index.handler` |
| `Cannot find package '@aws-sdk/...'` | zip에 node_modules 없음 | `bash scripts/build.sh`로 재빌드 |
| `Task timed out after 3.00 seconds` | 타임아웃 기본값 | 일반 구성 → 1분 30초 |
| `awslambda is not defined` | 호출 모드가 BUFFERED인데 스트리밍 핸들러 | 함수 URL 호출 모드를 `RESPONSE_STREAM`으로 |
| `Runtime.ImportModuleError` | ESM/CJS 혼용 또는 문법 오류 | `node --check`로 로컬 검사 |
| 메모리 부족 경고 | 1024MB 미달 | 일반 구성 → 1024MB |

## 3-4. Bedrock 관련

코드가 **원인별 한국어 진단 메시지**를 로그에 남깁니다 (`agent.mjs`의 `enrichBedrockError`).
로그의 `hint` 필드를 먼저 읽으세요.

| 예외 | 원인 | 해결 |
|---|---|---|
| `AccessDeniedException` | ① 모델 액세스 미승인 ② IAM 권한 부족 ③ 리전 불일치 | Bedrock → 모델 액세스 상태 확인 / IAM 정책의 `bedrock:InvokeModelWithResponseStream` 확인 |
| `ValidationException` | **`BEDROCK_MODEL_ID`가 이 리전에서 무효** (가장 흔함) | Bedrock → 모델 카탈로그 → 모델 상세 → "Inference profile IDs" 복사. 서울은 `apac.*` 또는 `global.*`. **`us.*`는 실패** |
| `ResourceNotFoundException` | 모델 ID 오타 | 위와 동일 |
| `ThrottlingException` | 온디맨드 쿼터 초과 | 잠시 후 재시도. 반복되면 Service Quotas에서 증량 요청, 또는 `global.*` 프로필로 전환(처리량이 더 높음) |

**모델 ID를 확실하게 알아내는 방법:**
```bash
cd backend && bash scripts/list-models.sh
```

## 3-5. 스트리밍이 안 될 때

`curl -N`으로 테스트했는데 응답이 한꺼번에 나오는 경우:

1. `/api/*` 동작의 **압축 자동 개설 = 아니요** 확인
2. `/api/*` 동작의 **캐시 정책 = CachingDisabled** 확인
3. 함수 URL **호출 모드 = RESPONSE_STREAM** 확인
4. Lambda 자체를 분리 테스트:
   ```bash
   # 함수 URL 인증을 임시로 NONE으로 바꾸고
   curl -N -X POST '<함수URL>chat' -H 'Content-Type: application/json' \
     -d '{"message":"테스트"}'
   # 끝나면 반드시 AWS_IAM으로 되돌리기
   ```
   여기서는 흘러나오면 CloudFront 문제, 여기서도 안 흐르면 Lambda 문제입니다.

**그래도 안 되면 스트리밍을 포기하는 게 낫습니다.**
`src/index.bufferedHandler`로 핸들러를 바꾸고 호출 모드를 `BUFFERED`로 하면
타이핑 효과만 없어지고 나머지는 전부 동작합니다.
프론트(`api.js`)가 JSON 응답도 처리하도록 만들어져 있어서 **프론트 수정이 필요 없습니다.**

## 3-6. 프론트엔드 관련

| 증상 | 원인 | 해결 |
|---|---|---|
| 빈 화면 (흰 화면) | 브라우저 콘솔에 JS 오류 | 개발자도구 콘솔 확인 |
| 404 (모든 경로) | `dist` 폴더째로 업로드함 | dist **안의 내용물**을 루트에 |
| CSS/JS 404 | 업로드 누락 | `assets/` 폴더가 올라갔는지 확인 |
| 옛 버전이 보임 | CloudFront 캐시 | 무효화 `/*` 실행 |
| 한글 입력 중 Enter가 전송됨 | (이미 처리됨) | `Composer.jsx`의 `isComposing` 검사 |

## 3-7. 도서 API 관련

CloudWatch Logs Insights:
```
fields @timestamp, label, base, status, hint, reason
| filter level = "warn"
| sort @timestamp desc
| limit 50
```

| 로그 | 원인 | 해결 |
|---|---|---|
| `googleBooks 검색 실패` status 403 | `unknownLocation` 또는 Books API 미활성 | `country=KR`은 코드에 이미 있음. Google Cloud Console에서 Books API 사용 설정 확인 |
| `googleBooks` status 429 | 일일 쿼터 1000회 초과 | 다음날 초기화. 또는 Cloud Console에서 증량 요청 |
| `hardcover 검색 실패` status 401 | 토큰 만료/형식 오류 | hardcover.app/account/api에서 재발급 |
| `hardcover` status 429 | 분당 60회 초과 | `CACHE_TTL_SECONDS`를 늘려 호출 감소 |
| `openLibrary 검색 실패` 403 | User-Agent 차단 | `CONTACT_EMAIL` 환경 변수 설정 |
| `gutendex 전체 실패` | 공개 인스턴스 장애 (흔함) | **정상 동작입니다.** Open Library 폴백이 자동 대체 |

## 3-8. 응답 품질 문제

| 증상 | 원인 | 해결 |
|---|---|---|
| 존재하지 않는 책을 추천 | 도구를 호출하지 않고 답변 | `prompt.mjs`의 "절대 규칙 1"을 더 강하게. `TEMPERATURE`를 0.2로 |
| 항상 영어권 책만 추천 | 도구에 `language`를 안 넘김 | 프롬프트에 "한국어 질문이면 language='ko'를 우선 시도" 추가 |
| 무드 설명이 없다 | Hardcover 결과가 비어 있음 | 로그에서 hardcover 호출 성공 여부 확인. 토큰 점검 |
| 무료 전자책을 안 알려줌 | `find_free_ebooks`를 안 부름 | 도구 description에 트리거 단어 추가 |
| 답변이 너무 길다 | 프롬프트의 길이 지시 | `prompt.mjs`의 "답변 길이" 섹션 조정 |
| 되묻기만 하고 추천을 안 함 | 프롬프트의 질문 규칙이 과함 | "이미 단서가 있으면 바로 추천" 부분 강화 |

---

# 4. 모니터링 루틴

## 매일 (2분)
1. **Cost Explorer** — Bedrock 막대가 튀는 날이 있나
2. **CloudWatch 알람** — 전부 OK 상태인가
3. 실제 서비스 접속해서 한 번 대화해보기
4. **사용자 평가 확인** — '아쉬움' 이 달린 질문이 있나 ([7-5절](#7-5-아쉬움이-붙은-질문-읽기))
   숫자보다 **어떤 질문이 실패했는지**가 개선의 단서입니다.

## 주 1회 (10분)

CloudWatch Logs Insights, `/aws/lambda/bookbot-api`:

```
# 사용량 요약
fields inputTokens, outputTokens, totalMs
| filter msg = "chat 완료"
| stats count(*) as 요청수,
        sum(inputTokens) as 입력토큰합,
        sum(outputTokens) as 출력토큰합,
        avg(totalMs)/1000 as 평균응답초,
        pct(totalMs, 95)/1000 as p95응답초
```

```
# 도구별 성능
fields tool, count, ms
| filter msg = "tool 완료"
| stats count(*) as 호출수, avg(ms) as 평균ms, avg(count) as 평균결과수 by tool
| sort 호출수 desc
```

```
# 오류 추이
fields @timestamp, msg
| filter level = "error"
| stats count(*) as 오류수 by bin(1d)
```

```
# 인기 검색어 (어떤 요청이 많은지 = 서비스 개선 힌트)
fields @timestamp, tool
| filter msg = "tool 완료"
| stats count(*) as 횟수 by tool
```

## 지표 정상 범위 (참고)

| 지표 | 정상 | 이상 신호 |
|---|---|---|
| 요청당 입력 토큰 | 6,000 ~ 12,000 | 15,000 초과 → 히스토리 비대 |
| 요청당 출력 토큰 | 400 ~ 900 | 1,500 초과 → 답변 과다 |
| 평균 응답 시간 | 5 ~ 12초 | 20초 초과 → 외부 API 지연 |
| p95 응답 시간 | < 20초 | 타임아웃(90초) 근접 시 위험 |
| 도구 호출 수/요청 | 1 ~ 2 | 4 → 상한 도달 (비용 증가) |
| 오류율 | < 2% | 5% 초과 → 조사 필요 |
| Lambda Throttles | 0 | > 0 → 트래픽 급증 |

---

# 5. 로컬 개발 환경

## 5-1. 백엔드 — 외부 API만 테스트 (AWS 불필요)

```bash
cd backend
npm install
export GOOGLE_BOOKS_API_KEY="AIza..."
export HARDCOVER_TOKEN="eyJ..."
npm run smoke
```

## 5-2. 백엔드 — Bedrock까지 테스트 (AWS 자격증명 필요)

```bash
aws configure          # 처음이면
export TEST_BEDROCK=1
export BEDROCK_MODEL_ID="apac.anthropic.claude-sonnet-4-5-20250929-v1:0"
export AWS_REGION=ap-northeast-2
npm run smoke
```

> DynamoDB 테이블이 없으면 캐시/세션/레이트리밋이 실패하지만,
> 전부 `fail-open`으로 설계되어 있어 **테스트는 정상 진행됩니다.**
> 로그에 경고만 찍힙니다. 의도된 동작입니다.

## 5-3. 프론트엔드 개발 서버

프론트만 고칠 때는 배포된 백엔드에 프록시를 걸면 편합니다.

```bash
cd frontend
cp .env.example .env.local
```

`.env.local`:
```
VITE_DEV_PROXY_TARGET=https://abcd1234.lambda-url.ap-northeast-2.on.aws
```

```bash
# Lambda 함수 URL 인증 유형을 임시로 NONE으로 변경한 뒤
npm run dev      # http://localhost:5173
# 개발이 끝나면 반드시 AWS_IAM으로 되돌리기
```

> ⚠️ 인증을 `NONE`으로 열어둔 채 잊으면 **누구나 API를 호출할 수 있습니다.**
> 개발 중에는 `RATE_LIMIT_PER_DAY`를 낮게 두고, 끝나면 즉시 `AWS_IAM`으로 되돌리세요.

## 5-4. Node.js 설치 (macOS)

```bash
brew install node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# 매번 입력하기 싫으면
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

node --version   # v22.x
```

---

# 6. 롤백

## 6-1. Lambda 코드 롤백

Lambda는 배포마다 버전을 만들 수 있습니다. 미리 발행해두면 롤백이 쉽습니다.

```bash
# 배포 직후 버전 발행 (라벨 붙이기)
aws lambda publish-version \
  --function-name bookbot-api --region ap-northeast-2 \
  --description "정상 동작 확인됨 $(date +%F)" \
  --query 'Version' --output text
```

버전을 안 만들어뒀다면 **이전 zip을 다시 업로드**하는 게 가장 빠릅니다.
`backend/dist/`에 zip을 날짜별로 남겨두는 습관이 도움이 됩니다:
```bash
cp dist/bookbot-backend.zip dist/bookbot-backend-$(date +%Y%m%d-%H%M).zip
```

## 6-2. 프론트엔드 롤백

이전 `dist/`를 다시 업로드 + 무효화. (S3 버전 관리를 껐으므로 이전 객체는 없습니다)
Git에서 이전 커밋을 체크아웃해 다시 빌드하는 것이 확실합니다.

## 6-3. 설정 롤백

환경 변수는 값을 되돌리고 저장하면 즉시 반영됩니다.
**변경 전 값을 메모해두는 습관**이 가장 실용적인 롤백 대비입니다.

## 6-4. 긴급 정지

Lambda → 구성 → 동시성 → **예약된 동시성 `0`** → 저장.
즉시 모든 API 호출이 차단됩니다. 값을 되돌리면 복구됩니다.
[04-cost-and-cleanup.md 5-4](./04-cost-and-cleanup.md) 참고.

---

# 7. 답변 평가 읽기

사용자가 답변 아래 **좋음 / 아쉬움** 을 누르면 그 값이 **원래 채팅 기록 항목에**
속성으로 덧붙습니다. 별도 테이블도, 별도 파티션도 없습니다.

## 7-1. 왜 같은 항목에 붙였는가

평가만 따로 저장하면 "무엇에 대한 평가인지" 보려고 매번 두 번 조회해야 합니다.
같은 항목에 붙이면 **콘솔에서 한 줄만 봐도 질문·답변·평가가 다 보입니다.**

| 속성 | 값 | 비고 |
|---|---|---|
| `질문` | 사용자 입력 | 기존 |
| `답변` | 봇 응답 | 기존 |
| `평가` | `좋음` \| `아쉬움` | **신규.** 누르지 않으면 속성 자체가 없음 |
| `feedbackAt` | ISO 타임스탬프 | 신규 |
| `의견` | 자유 입력 (최대 500자) | 신규. 현재 UI는 안 보냄 |

쓰기는 `UpdateItem` + `ConditionExpression: attribute_exists(pk)` 입니다.
`PutItem` 이 아니라서 **질문·답변을 덮어쓰지 않고**, 조건 때문에
**없는 기록에 평가만 든 빈 항목이 생기지 않습니다.**

## 7-2. 콘솔에서 보기

DynamoDB 콘솔 → 테이블 `bookbot` → **항목 탐색** → **쿼리**

| 칸 | 입력 |
|---|---|
| 파티션 키 `pk` | `LOG#2026-08-31` |

날짜는 **한국 시간(KST) 기준**입니다. 오늘 대화를 보려면 오늘 날짜를 넣으세요.
자정 무렵 대화는 앞뒤 날짜를 둘 다 확인하는 게 안전합니다.

## 7-3. 평가가 달린 것만 골라 보기

CLI 가 훨씬 빠릅니다.

```bash
REGION=us-east-1
DAY=$(TZ=Asia/Seoul date +%F)     # 오늘 (KST)

# 평가가 달린 대화만
aws dynamodb query --table-name bookbot --region $REGION \
  --key-condition-expression 'pk = :p' \
  --filter-expression 'attribute_exists(#f)' \
  --expression-attribute-names '{"#f":"평가"}' \
  --expression-attribute-values "{\":p\":{\"S\":\"LOG#$DAY\"}}" \
  --query 'Items[].{v:"평가".S, q:"질문".S}' --output table
```

★ **한글 속성명은 그대로 쓸 수 없습니다.** DynamoDB 표현식의 이름은
영숫자·밑줄만 허용하므로 `--expression-attribute-names` 로 `#f` 같은
자리표시자를 거쳐야 합니다. JMESPath(`--query`) 쪽도 `"평가"` 처럼
따옴표로 감싸야 합니다. 감싸지 않으면 파싱 오류가 납니다.

`--filter-expression` 은 읽은 **뒤에** 걸러내므로 읽기 비용은 그날 전체분입니다.
하루 수십 건 규모에서는 무의미한 차이입니다.

## 7-4. 만족도 집계

```bash
REGION=us-east-1
# 최근 7일 만족도
for i in 0 1 2 3 4 5 6; do
  DAY=$(TZ=Asia/Seoul date -v-${i}d +%F 2>/dev/null || date -d "-$i day" +%F)
  RESULT=$(aws dynamodb query --table-name bookbot --region $REGION \
    --key-condition-expression 'pk = :p' \
    --filter-expression 'attribute_exists(#f)' \
    --expression-attribute-names '{"#f":"평가"}' \
    --expression-attribute-values "{\":p\":{\"S\":\"LOG#$DAY\"}}" \
    --query 'Items[]."평가".S' --output text 2>/dev/null)
  GOOD=$(echo "$RESULT" | tr '\t' '\n' | grep -c '좋음' || true)
  BAD=$(echo "$RESULT" | tr '\t' '\n' | grep -c '아쉬움' || true)
  printf '%s  좋음 %2d  아쉬움 %2d\n' "$DAY" "$GOOD" "$BAD"
done
```

## 7-5. 아쉬움이 붙은 질문 읽기

집계 숫자보다 **어떤 질문이 실패했는지**가 중요합니다.

```bash
DAY=$(TZ=Asia/Seoul date +%F)
aws dynamodb query --table-name bookbot --region us-east-1 \
  --key-condition-expression 'pk = :p' \
  --filter-expression '#f = :v' \
  --expression-attribute-names '{"#f":"평가"}' \
  --expression-attribute-values "{\":p\":{\"S\":\"LOG#$DAY\"},\":v\":{\"S\":\"아쉬움\"}}" \
  --query 'Items[]."질문".S' --output text | tr '\t' '\n'
```

여기 나온 질문을 그대로 서비스에 다시 넣어보고, 원인에 따라 대응이 갈립니다.

| 원인 | 증상 | 대응 |
|---|---|---|
| 국내서를 못 찾음 | 한국어 질문인데 영문판·고전만 나옴 | 알라딘 키 확인 ([03-external-apis 8-E](./03-external-apis.md#8-e-즉시-테스트)) |
| 주제가 엉뚱함 | "한국 스릴러" 에 한국사·여행서가 나옴 | 장르 사전에 그 장르가 있는지 확인 ([9-3절](#9-3-주제가-엉뚱할-때)) |
| 무드 추천이 엉뚱함 | "위로되는 책"에 무거운 책 | `HARDCOVER_TOKEN` 확인. **비어 있으면 무드·평점·내용주의가 전부 없습니다** |
| 말투·형식 문제 | 목록만 나열, 이유 설명 없음 | `backend/src/prompt.mjs` 수정 → 프롬프트만 재배포 (1-3절) |
| 과도한 차단 | 정상 질문이 거부됨 | `docs/08-guardbench.md` 로 오탐 확인 후 정책 조정 |

## 7-6. 평가가 저장되지 않을 때

| 증상 | 원인 | 확인 |
|---|---|---|
| 평가 버튼이 아예 안 보임 | `logRef` 가 오지 않음 | 개발자도구 Network → 채팅 응답의 `done` 이벤트에 `logRef` 가 있는지. 없으면 `CHAT_LOG_ENABLED` 확인 |
| 차단된 답변에 버튼 없음 | **의도된 동작** | 정책 차단 응답은 평가 대상이 아님 |
| 눌러도 반응 없음 (400) | `logRef` 형식 불일치 | Lambda 로그 `filter-pattern 'feedback'` |
| 404 가 옴 | 기록이 TTL 로 이미 만료됨 | 채팅 기록 TTL 확인. 오래된 대화는 평가할 수 없음 |

평가 실패는 **대화를 끊지 않습니다.** 프론트가 예외를 삼키고 안내 문구만 띄웁니다.
평가는 부가 기능이라 이것 때문에 채팅이 멈추면 안 됩니다.

## 7-7. 평가에 레이트리밋이 없는 이유

채팅 레이트리밋(분당 10회·하루 150회)을 평가에 같이 걸면
**평가를 누를 때마다 채팅 할당량이 깎입니다.** 사용자가 평가를 눌렀다고
대화를 못 하게 되는 건 말이 안 됩니다.

대신 WAF 의 IP 단위 제한(5분당 300회)이 남용을 막습니다.
`04-guardrails.sh` 를 실행하지 않았다면 이 보호막이 없으니 확인하세요.

---

# 8. 읽을 목록 운영 메모

## 8-1. 서버에 아무것도 저장되지 않습니다

읽을 목록은 **브라우저 `localStorage` 에만** 있습니다.
DynamoDB·Lambda·API 호출이 전혀 없습니다.

| 항목 | 값 |
|---|---|
| 저장 위치 | `localStorage['bookbot.saved']` |
| 상한 | **200권** |
| 권당 크기 | 약 280바이트 (원본 레코드 약 8KB 에서 축소) |
| 서버 비용 | **0원** |

그래서 운영 관점의 함의가 있습니다.

- **장애 대응할 것이 없습니다.** 백엔드가 죽어도 읽을 목록은 열립니다.
- **사용자 데이터를 저희가 갖고 있지 않습니다.** GDPR 문의가 오면
  "브라우저에만 저장되며 서버로 전송되지 않습니다" 가 정확한 답입니다.
- **사용자가 브라우저를 바꾸면 목록이 사라집니다.** 이건 로그인이 없어서 생기는
  의도된 한계입니다. 문의가 반복되면 그때 계정 기능을 검토합니다.

## 8-2. 예상되는 문의와 답

| 문의 | 원인 | 답 |
|---|---|---|
| "저장한 책이 사라졌어요" | 다른 브라우저·기기, 또는 브라우저 데이터 삭제 | 같은 브라우저에서만 유지됩니다 |
| "저장이 안 돼요" | 시크릿 모드 (localStorage 차단) | 화면에 경고가 표시됩니다. 일반 창을 쓰세요 |
| "200권이 넘어서 안 담겨요" | 상한 도달 | 의도된 동작. **오래된 항목을 몰래 지우지 않습니다** |
| "읽을 목록 버튼이 안 보여요" | 담은 책이 0권 | 한 권이라도 담으면 헤더에 나타납니다 |

## 8-3. 왜 넘치면 자동 삭제하지 않는가

상한을 넘으면 거부하고 안내합니다. 오래된 항목을 자동으로 지우면
**사용자가 모르는 사이에 저장한 책이 없어집니다.** 사용자 데이터를
조용히 삭제하는 건 어떤 편의보다 나쁩니다.

## 8-4. 저장 형태를 바꿀 때 (`shrink()` 수정)

`frontend/src/lib/savedBooks.js` 의 `VERSION` 을 올리세요.
버전이 다르면 기존 데이터를 조용히 버리고 빈 목록으로 시작합니다.
버전을 안 올리면 **옛 형태와 새 형태가 섞여 카드 렌더링이 깨집니다.**

---

# 9. 회귀 테스트 모음

배포 전에 이 순서로 돌리세요. 전부 네트워크 없이(스모크만 예외) 몇 초에 끝납니다.

```bash
cd backend
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"    # 로컬 환경에 맞게
export AWS_REGION=us-east-1

npm run check          # 문법 — 전 파일 import 검사
npm run test:policy    # 정책·의도분류 98건
npm run test:agent     # 에이전트 루프 18건
npm run test:features  # 평가·알라딘·국중·장르·정확조회·라우팅·카드선별·보충조회 183건
npm run smoke          # 외부 API 실호출 14건 (네트워크 필요)

cd ../frontend
npm run test:saved     # 읽을 목록 저장소 30건
npm run check:render   # 화면 렌더 검수 22건 (브라우저 없이)
npm run build          # 프론트 빌드
```

전부 통과하면 **360건**입니다. 하나라도 실패하면 배포하지 마세요.

| 스크립트 | 무엇을 지키는가 |
|---|---|
| `test:policy` | **주제 검열이 되살아나지 않음**(키워드 25종 통과), 미성년 안전 절대선, 인젝션 방어 |
| `test:agent` | 도구 호출 루프가 무한히 돌지 않음, 부분 실패 허용 |
| `test:features` | **`logRef` 위조로 남의 기록을 훼손할 수 없음**, 평가가 질문·답변을 덮어쓰지 않음, 알라딘 저자 정제, **장르 요청에 엉뚱한 주제가 섞이지 않음** |
| `test:saved` | 다국어 제목 중복 판정, 상한에서 기존 데이터 보존, 시크릿 모드 폴백 |
| `check:render` | 평가 버튼이 **답변 완료 후에만** 보임, 오류·차단 턴에는 안 보임, 축소 저장된 책도 카드가 깨지지 않음 |
| `smoke` | 외부 API 5종 연결과 ISBN 병합 |

> `smoke` 는 외부 API를 실제로 호출하므로 **상대 서버 상태에 따라 실패할 수 있습니다.**
> 4회 중 1회 정도 Open Library·Gutendex 응답이 늦어 실패로 찍혔습니다.
> 다시 돌려서 통과하면 코드 문제가 아닙니다. 나머지 스크립트는 네트워크를 쓰지 않아
> 항상 같은 결과가 나옵니다 — 그쪽이 실패하면 진짜 문제입니다.

## 9-1. `test:features` 가 특히 중요한 이유

`logRef` 는 **브라우저를 거쳐 되돌아오는 값**입니다. 사용자가 조작할 수 있습니다.
검증이 뚫리면 `SESSION#...` 을 보내 **남의 세션 데이터를 망가뜨릴 수 있습니다.**

이 테스트는 `SESSION#`·`CACHE#`·`RL#`·경로 이탈 문자·과도하게 긴 값 등
13가지 조작 시도가 전부 거부되는지 확인합니다.
`parseLogRef` 를 손대면 **반드시** 이 테스트를 다시 돌리세요.

## 9-2. 흰 화면 사고 재발 방지

과거에 `useLayoutEffect` 안에서 상태를 바꾸고 그 상태를 의존성에 넣어
렌더가 순환하며 화면이 비는 장애가 있었습니다.

```bash
cd frontend && grep -rn 'useLayoutEffect\|useEffect' src/ | wc -l
```

새 `useEffect`·`useLayoutEffect` 를 추가할 때는
**그 안에서 바꾸는 상태를 의존성 배열에 넣지 마세요.**
`useSyncExternalStore` 를 쓸 때는 `getSnapshot` 이
**매번 새 객체를 만들지 않는지** 확인하세요 (같은 참조를 반환해야 합니다).

---

# 부록: 자주 쓰는 명령 모음

```bash
# ── 상태 확인 ────────────────────────────────────────────
DOMAIN=<배포도메인>
REGION=ap-northeast-2

curl -s https://$DOMAIN/api/health | python3 -m json.tool
curl -N -X POST https://$DOMAIN/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"무료 고전 추천해줘"}'

# ── Lambda ──────────────────────────────────────────────
aws lambda get-function-configuration --function-name bookbot-api --region $REGION \
  --query '{Handler:Handler,Runtime:Runtime,Arch:Architectures,Mem:MemorySize,Timeout:Timeout}'

aws lambda get-function-configuration --function-name bookbot-api --region $REGION \
  --query 'Environment.Variables'

# 실시간 로그 따라가기
aws logs tail /aws/lambda/bookbot-api --region $REGION --follow --format short

# 오류만 보기
aws logs tail /aws/lambda/bookbot-api --region $REGION --since 1h \
  --filter-pattern '"level":"error"'

# ── Bedrock ─────────────────────────────────────────────
bash backend/scripts/list-models.sh

aws bedrock-runtime converse --region $REGION \
  --model-id "$BEDROCK_MODEL_ID" \
  --messages '[{"role":"user","content":[{"text":"한 문장으로 인사해줘"}]}]' \
  --inference-config '{"maxTokens":100}'

# ── DynamoDB ────────────────────────────────────────────
# 저장된 아이템 종류별 개수 (Scan은 비용이 들지만 데모 규모에선 무방)
aws dynamodb scan --table-name bookbot --region $REGION \
  --projection-expression "pk" --query 'Items[].pk.S' --output text | \
  tr '\t' '\n' | cut -d'#' -f1 | sort | uniq -c

# ── CloudFront ──────────────────────────────────────────
aws cloudfront get-distribution --id <배포ID> \
  --query 'Distribution.{Status:Status,Domain:DomainName}'

aws cloudfront create-invalidation --distribution-id <배포ID> --paths "/*"
```

---

## 9-3. 주제가 엉뚱할 때

증상: "한국 스릴러 추천해줘" 에 한국사·여행서·문학 연구서가 카드로 나옴.

### 왜 이런 일이 생기는가

원인이 두 층입니다.

**1층 — 소스가 죽어 있음 (가장 흔함)**

키가 없는 소스는 조용히 0권을 돌려줍니다. 실측한 상태는 이랬습니다.

| 소스 | 결과 | 원인 |
|---|---|---|
| Google Books | 0권 | 키 없음 → 익명 호출이 `429 Quota exceeded (Queries per day)` |
| Hardcover | 0권 | 토큰 없음 |
| 알라딘 | 0권 | 키 없음 |
| Open Library | 0권 | 한국어 복합 질의를 못 찾음 |

5개 소스 전부 0권이면 LLM 이 검색어를 바꿔 재시도하고, 그 과정에서 주제를 벗어납니다.

```bash
# 어떤 소스가 살아 있는지 한 줄로
curl -s https://$(bash infra/print-domain.sh)/api/health | python3 -m json.tool | grep -A8 '"secrets"'
```

**2층 — 지역어가 검색 키워드로 나감**

"한국" 은 장르가 아니라 언어 조건인데 키워드로 보내면 검색 엔진이 **주제어**로 읽습니다.
그러면 한국을 *다룬* 책이 매칭됩니다. 실측 결과입니다.

```
Open Library "Korea"        → Pyongyang / Korea's Place in the Sun / Korea(여행서)
Open Library "한국 소설"     → 한국 현대 소설 연구 / 1960년대 한국 소설 연구
Open Library subject=thriller → Treasure Island(1880) / Dracula(1897)
```

### 지금은 어떻게 막고 있는가

`backend/src/tools/genre.mjs` 가 세 가지를 합니다.

1. **질의 분해** — "한국 스릴러" → `language=ko` + `genre=thriller` + 키워드 없음
2. **소스별 번역** — Google `subject:"Thrillers"`, Open Library `thriller`, 알라딘 `"스릴러"`
3. **적합성 판정** — 결과가 그 장르인지 보고, 어긋나면 정렬에서 내리고 잘라냄

```bash
cd backend && npm run test:features   # ■ 장르 절에서 28건 확인
```

### 장르를 추가하려면

`GENRES` 배열에 항목을 하나 넣습니다.

```javascript
{
  key: 'warfiction',
  words: ['전쟁소설', 'war fiction'],   // 질의에서 이 말을 찾습니다
  gbSubject: 'War & Military',          // Google Books subject: 값
  olSubjects: ['war_stories'],          // Open Library 슬러그
  hcQuery: 'war fiction',               // Hardcover 검색어(영어)
  aladin: '전쟁소설',                    // 알라딘 검색어(한국어)
  match: ['war', 'military', '전쟁'],    // 결과 분류에서 찾을 단어
  near: ['historicalFiction'],          // 같은 서가로 묶이는 장르
  fiction: true,                        // 논픽션 결과를 강등할지
}
```

`match` 를 너무 좁게 쓰지 마세요. 정유정 「종의 기원」의 알라딘 분류는
`추리/미스터리소설` 이라 "스릴러" 로는 안 잡힙니다. 그래서 `near` 로
인접 장르를 함께 인정합니다. 국내 서점은 스릴러·추리·미스터리·범죄를
사실상 한 서가로 묶습니다.

### 필터가 과하게 걸러낼 때

`ACADEMIC_MARKERS` 와 `NONFICTION_MARKERS` 에 걸리면 소설 요청에서 제외됩니다.
정상적인 소설이 사라지면 그 책의 분류를 확인하세요.

```bash
cd backend && node -e '
process.env.BOOKBOT_LOCAL="1";
const { interpret, classify } = await import("./src/tools/genre.mjs");
const spec = interpret({ query: "한국 스릴러" });
console.log(classify({ title: "확인할 제목", categories: ["여기에 분류 넣기"] }, spec.genre));
' --input-type=module
```

`fit` 이 `-1` 이면 제외 대상입니다. `academic: true` 또는 `nonfiction: true` 중
무엇 때문인지 함께 나옵니다.

안전장치가 하나 있습니다. **필터 후 0권이 되면 필터를 포기하고 전부 보여줍니다.**
0권을 주면 LLM 이 검색어를 임의로 바꿔 재시도하면서 주제를 더 크게 벗어나기 때문입니다.

---

# 10. 원샷 배포 (`infra/oneshot.sh`)

CloudShell 에 zip 을 업로드한 뒤 **한 줄**만 붙여넣습니다.

```bash
cd ~ && rm -rf bookbot && unzip -oq bookbot-cloudshell.zip -d bookbot && cd bookbot && bash infra/oneshot.sh
```

## 무엇을 하는가

| 단계 | 내용 |
|---|---|
| 1/6 | Node 22 확인. 낮으면 nvm 으로 설치 |
| 2/6 | `~/keep/secrets.env` → `infra/secrets.env` 복원. 비어 있는 키를 미리 경고 |
| 3/6 | `update.sh` — 상태 복원 → 백엔드 → 프론트 → 캐시 무효화 → 진단 |
| 4/6 | `04-guardrails.sh` — WAF · 알람 · 예산 (재실행 안전) |
| 5/6 | `verify.sh` — 실제 호출 검증 |
| 6/6 | 헬스체크로 키 로드 확인 + 브라우저 확인 목록 출력 |

## API 키는 한 번만 넣습니다

zip 을 새로 올릴 때마다 다시 입력하지 않습니다. 2단계에서 순서대로 찾습니다.

| 순서 | 어디서 | 언제 쓰이는가 |
|---|---|---|
| 1 | `~/keep/secrets.env` | 보통. CloudShell 홈에 남아 있음 |
| 2 | **AWS 에서 자동 복원** | 홈이 초기화됐을 때 |
| 3 | 서식 생성 후 멈춤 | 첫 배포 (키가 AWS 에도 없음) |

### 왜 `~/keep` 인가

위 한 줄은 `rm -rf bookbot` 으로 시작합니다. 저장소 안(`infra/secrets.env`)에
키를 두면 **다음 배포 때 사라집니다.** 실제로 그렇게 키를 한 번 잃었습니다.
`~/keep` 은 압축 해제 대상 밖이라 살아남습니다.

### 홈이 초기화돼도 다시 입력하지 않습니다

한 번 배포하면 키가 전부 AWS 에 남습니다.

| 값 | 저장 위치 |
|---|---|
| 도서 API 키 3종 | SSM Parameter Store (SecureString) |
| `BEDROCK_MODEL_ID` · `CONTACT_EMAIL` | Lambda 환경변수 |
| `ALERT_EMAIL` | SNS 이메일 구독 |

`restore_secrets_from_aws()` 가 이 세 곳에서 읽어 `~/keep/secrets.env` 를 다시 만듭니다.
CloudShell 홈은 120일 미사용 시 삭제되는데, 그때도 사용자가 할 일이 없습니다.

> SSM 값은 인자가 아니라 **환경변수로** python 에 넘깁니다.
> 인자로 넘기면 키가 프로세스 목록(`ps`)에 노출됩니다.

### 키를 바꾸거나 추가할 때

```bash
nano ~/keep/secrets.env      # 값 수정
# 그다음 위 한 줄 다시 실행
```

빈 칸으로 남긴 키는 **SSM 의 기존 값을 지우지 않습니다.** `put_param` 이
빈 값이면 덮어쓰지 않고 건너뜁니다. 그래서 일부만 채워 넣어도 안전합니다.

### 첫 배포

키가 어디에도 없으면 서식을 만들고 멈춥니다(exit 2).

```bash
nano ~/keep/secrets.env      # 값 채우고 Ctrl+O, Enter, Ctrl+X
```

`BEDROCK_MODEL_ID` 가 비면 배포 전에 멈춥니다 — 빈 값으로 올리면 채팅이 반드시
실패하기 때문입니다. 도서 API 키가 비면 경고만 하고 계속합니다(서비스는 동작합니다).

## 옵션

| 환경변수 | 효과 |
|---|---|
| `SKIP_VERIFY=1` | 배포 후 검증 생략 (빠르게) |
| `SKIP_GUARDRAILS=1` | WAF·알람 단계 생략 |
| `ONLY=frontend` | 프론트엔드만 재배포 |
| `ONLY=backend` | 백엔드만 재배포 |

```bash
SKIP_VERIFY=1 bash infra/oneshot.sh
```

## 단계를 나누고 싶을 때

원샷이 어디서 멈췄는지 알면 그 단계만 따로 돌릴 수 있습니다.

```bash
bash infra/update.sh          # 백엔드 + 프론트 + 캐시 무효화
bash infra/04-guardrails.sh   # WAF · 알람 · 예산
bash infra/verify.sh          # 실제 호출 검증
bash infra/doctor.sh          # 진단 + 자동 수정
```

## 실패 지점별 대처

| 멈춘 곳 | 원인 | 대처 |
|---|---|---|
| 자격증명 | CloudShell 세션 만료 | 브라우저 새로고침 후 CloudShell 재접속 |
| 1/6 Node | nvm 설치 실패 | 수동 설치 후 재실행 |
| 2/6 비밀값 | 파일 없음 / 모델 ID 빈 값 | `nano ~/keep/secrets.env` 후 재실행 |
| 3/6 배포 | 상태 복원 실패 | `bash infra/seed-state.sh` 단독 실행해 메시지 확인 |
| 3/6 배포 | 핸들러 불일치로 500 | API 이름이 `bookbot-http-api` 인지 확인 (3-절 참고) |
| 4/6 가드레일 | 일부 실패 | 경고만 남기고 계속합니다. 배포 자체는 완료됨 |
| 5/6 검증 | 실패 항목 보고 | 배포는 끝난 상태. 3절 트러블슈팅 참고 |

---

# 11. 카드 선별 — 답변과 카드를 맞추는 규칙

## 무엇이 바뀌었나

예전에는 도구가 찾은 책이 **LLM 을 거치지 않고 그대로** 카드가 되었습니다.

```
질문: "박경리 토지 같은 한국 대하소설 추천해줘"
카드: 26장   ← 「혼불 1」~「혼불 6」이 각각 별도 카드
답변: "《태백산맥》 … 이 세 작품을 강력히 추천드립니다"
```

26장 중 23장이 답변에 없는 책이었습니다. 사용자는 왜 나왔는지 알 수 없고,
한 작품이 목록을 뒤덮습니다.

지금은 `tools/present.mjs` 가 세 단계로 정리합니다.

| 단계 | 내용 |
|---|---|
| 1 | **시리즈 접기** — 「혼불 1」~「혼불 6」 → 「혼불」 한 장 |
| 2 | **답변에서 언급된 책만** 남김 |
| 3 | 하나도 못 맞추면 상위 6권으로 폴백 |

위 사례는 26장 → **4장**(토지·태백산맥·혼불·아리랑)이 됩니다.

## 왜 도구를 추가하지 않았나

"LLM 이 `present_books` 도구로 번호를 골라 돌려준다" 를 먼저 검토했고 버렸습니다.

- 도구 반복 예산이 **3회**입니다(API Gateway 통합 타임아웃 30초 대응).
  검색 2회 + 선별 1회면 답변 쓸 라운드가 없습니다.
- LLM 이 호출을 빼먹으면 전체가 무너집니다. 프롬프트 준수에 의존하게 됩니다.
- 왕복이 늘어 지연과 토큰이 증가합니다.

대신 **이미 생성된 답변 텍스트**를 씁니다. LLM 은 어차피 제목을 답변에 적으므로
(프롬프트가 원제를 요구) 추가 비용이 **0** 입니다.

## 매칭 방식

정규화한 답변 안에 정규화한 제목(권차 제거)이 들어 있는지 봅니다.
정규화가 공백·기호를 모두 없애므로 `《》`, `**`, `「」` 같은 장식은 방해하지 않습니다.

```
답변  "**《태백산맥》** — 조정래"
제목  "태백산맥 1"  → 권차 제거 "태백산맥"  → 포함 ✓
```

## 권차 판정에 상한이 있습니다

표시 없는 맨 숫자는 **20 이하만** 권차로 봅니다.

| | |
|---|---|
| 떼어냄 | 「혼불 1」, 「태백산맥 10」, 「토지 3권」, 「임꺽정(1)」, 「Dune Vol. 2」 |
| 남김 | **「Fahrenheit 451」**, 「Catch-22」, 「1984」, 「Room 237」 |

상한이 없으면 「Fahrenheit 451」이 「Fahrenheit」가 됩니다. 실측으로 잡았습니다.
`권`·`Vol.`·괄호처럼 **표시가 붙은 경우**는 숫자가 커도 권차로 봅니다.

## 운영에서 확인하는 방법

로그에 선별 내역이 남습니다.

```bash
aws logs tail /aws/lambda/bookbot-api --region us-east-1 --since 30m \
  --filter-pattern '카드 선별'
```

```json
{"msg":"카드 선별","total":26,"collapsed":15,"presented":4,"dropped":7,"reason":"mentioned"}
```

| 필드 | 뜻 |
|---|---|
| `total` | 검색으로 찾은 권수 |
| `collapsed` | 시리즈 접기로 줄어든 수 |
| `presented` | 실제로 카드가 된 수 |
| `dropped` | 답변에 없어서 제외된 수 |
| `reason` | `mentioned`(정상) / `fallback` / `empty` |

`chat 완료` 로그에도 `booksFound`·`booksShown`·`selection` 이 함께 나옵니다.

**`reason: fallback` 이 자주 보이면 문제입니다.** LLM 이 답변에 제목을 안 적거나
제목을 바꿔 쓰고 있다는 뜻입니다. 프롬프트의 "원제를 반드시 포함" 규칙을 확인하세요.

## 답변 품질 규칙 (프롬프트)

카드 선별과 함께 프롬프트에 답변 요구사항을 넣었습니다.

- **조건을 하나하나 확인** — "요즘 나온 한국 스릴러" 는 조건 3개입니다.
  다 만족하는 책이 없으면 어느 조건을 못 맞췄는지 밝히게 했습니다.
- **3~5권으로 좁히기** — 도구가 20권을 줘도 전부 언급하지 않습니다.
- **시리즈는 한 번만** 언급.
- **근거 제시** — 무드 태그·평점과 표본 수·출간연도·분류로만 말합니다.
  "재미있어요" 같은 말은 금지했습니다.

```bash
cd backend && npm run test:features   # ■ 카드 선별 절에서 33건 확인
```

## 11-1. 보충 조회 — 답변에 나온 책은 반드시 카드가 있습니다

카드 선별만으로는 부족한 경우가 있습니다. **LLM 이 언급한 책이 검색 결과에 없을 때**입니다.
자기 지식으로 말했거나, 검색어가 달라 도구가 못 찾은 경우입니다.
사용자에게는 "추천했는데 카드가 없다" 로 보입니다.

그래서 답변이 끝난 뒤 한 단계를 더 돕니다.

```
답변 생성 완료
  ↓
답변에서 제목·저자 추출          《태백산맥》 — 조정래
  ↓
카드가 없는 것만 골라냄
  ↓
lookup_books 로 정확 조회        제목+저자 → 알라딘·국중·Google
  ↓
검증 통과한 것만 카드 추가
```

`lookup_books` 를 재사용하므로 소스 라우팅(국내/해외)과 제목·저자 검증이 그대로 적용됩니다.
**저자가 다르면 채택하지 않습니다** — 같은 제목의 해설서·만화판이 붙지 않습니다.

### 시간 예산

에이전트 예산(18초)을 다 쓴 뒤에 도는 단계입니다. API Gateway 통합 타임아웃이
30초라 남은 여유만 씁니다.

| 환경변수 | 기본 | 뜻 |
|---|---|---|
| `BACKFILL_BUDGET_MS` | 6000 | 보충 조회에 허용하는 추가 시간 |
| `BACKFILL_MAX_ITEMS` | 8 | 한 번에 보충할 최대 권수 |

남은 시간이 1.5초 미만이면 건너뜁니다. 답변은 이미 스트리밍으로 나갔으므로
사용자는 글을 읽고 있고, 카드만 잠시 뒤에 붙습니다.

### 제목 추출 규칙

프롬프트가 `《제목》 — 저자` 형식을 쓰게 합니다. 인식하는 표기는 이렇습니다.

| 인식함 | 인식하지 않음 |
|---|---|
| `《제목》` `『제목』` `「제목」` `【제목】` | `**굵게**` (강조에도 쓰임) |
| `*Title*` (단일 별표 이탤릭) | `"인용"` (한국어에서 인용에 흔함) |

`"정말 좋아요"` 같은 문구가 제목으로 잡혀서 인용부호는 제외했습니다.

저자는 제목 바로 뒤에서 구분자(`—` `–` `-` `by` `(`)가 있을 때만 인정합니다.
그리고 이름만 남깁니다.

```
《혼불》 — 최명희를 추천합니다        → 최명희
《설국》 — 가와바타 야스나리          → 가와바타 야스나리
*Gone Girl* by Gillian Flynn is…  → Gillian Flynn
```

> 조사 판정은 **낱말 전체**로 합니다. 접두 비교를 했다가
> 「가와바타」가 조사 `가` 로 시작한다고 잘렸습니다. 실측으로 잡았습니다.

### 추천 권수

프롬프트가 **10권 이상**을 요구합니다. 그에 맞춰 상한을 올렸습니다.

| | 이전 | 지금 |
|---|---|---|
| 도구 `limit` 기본 | 8 | **14** |
| 도구 `limit` 상한 | 10 | **20** |
| `lookup_books` 항목 상한 | 6 | **10** |
| 폴백 카드 수 | 6 | **12** |

도구 결과가 10권보다 적으면 프롬프트가 있는 만큼만 쓰게 하고,
"확인된 것은 N권" 이라고 밝히게 합니다. 없는 책을 채워 넣지 않습니다.

### 확인

```bash
aws logs tail /aws/lambda/bookbot-api --region us-east-1 --since 30m \
  --filter-pattern '보충 조회'
```

```json
{"msg":"보충 조회 시작","titles":["태백산맥","혼불","아리랑"],"remainingMs":8200}
{"msg":"보충 조회 완료","asked":3,"got":3,"ms":1840}
```

`asked` 와 `got` 이 크게 다르면 그 책들이 어느 소스에도 없거나 저자 검증에서
걸린 것입니다. `카드 선별` 로그의 `backfilled` 값으로도 몇 권이 보충됐는지 보입니다.
