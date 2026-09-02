# 09. 전체 작업 기록 — 만든 것 전부

이 문서는 **빠짐없이 적는 것**이 목적입니다. 읽기 편한 요약은
[10-summary.md](./10-summary.md), 서비스·AWS 관점 정리는
[11-service-and-aws.md](./11-service-and-aws.md) 를 보세요.

- 프로젝트: **BookBot / Un Livre Pour Vous · CHOWOO**
- 리전: `us-east-1` · 모델: `us.anthropic.claude-sonnet-4-6`
- 사이트: `https://CLOUDFRONT_DOMAIN_MASKED.cloudfront.net`

---

## 1. AWS 리소스 전체 목록

| 종류 | 이름 / ID | 설정 |
|---|---|---|
| Lambda | `bookbot-api` | Node.js 22 · arm64 · 1024MB · 90초 · 핸들러 `src/index.bufferedHandler` |
| IAM 역할 | `bookbot-lambda-role` | 정책 `bookbot-lambda-policy` (최소 권한) |
| DynamoDB | `bookbot` | 단일 테이블 · 온디맨드 · TTL 속성 `ttl` |
| SSM Parameter Store | `/bookbot/prod/*` | SecureString 4개 |
| API Gateway (HTTP API) | `API_ID_MASKED` (`bookbot-http-api`) | `ANY /api/{proxy+}` · `$default` 스테이지 |
| S3 | `bookbot-web-ACCOUNT_ID_MASKED-us-east-1` | 완전 비공개 (OAC 로만 접근) |
| CloudFront | `E2FV2DFCXI5QI2` | 오리진 2개 (S3 + API GW) |
| WAF (CLOUDFRONT scope) | `bookbot-waf` | IP당 5분 300회 |
| SNS | `bookbot-alerts` | 이메일 구독 |
| CloudWatch 알람 | 4개 | 오류·스로틀·응답시간·Bedrock 토큰 |
| AWS Budgets | 2개 | 전체 $100/월 · Bedrock $50/월 |
| Bedrock | Claude Sonnet 4.6 | `ConverseStream` + 도구 호출 |

### SSM 파라미터

| 이름 | 용도 | 없으면 |
|---|---|---|
| `/bookbot/prod/GOOGLE_BOOKS_API_KEY` | 도서 검색 | 커버리지 하락 |
| `/bookbot/prod/HARDCOVER_TOKEN` | 무드·평점·내용주의 | 정서 기반 추천 근거 상실 |
| `/bookbot/prod/ALADIN_TTB_KEY` | 국내 도서 | 한국어 결과 빈약 |
| `/bookbot/prod/ORIGIN_SECRET` | 오리진 검증 | 함수 URL 직접 호출 가능 |

### DynamoDB 항목 4종 (단일 테이블)

| pk | sk | 내용 | TTL |
|---|---|---|---|
| `SESSION#<uuid>` | `META` | 대화 히스토리 | 24시간 |
| `LOG#<YYYY-MM-DD>` | `<ISO타임스탬프>#<세션8자>` | 질문·답변·평가 | 90일 |
| `CACHE#<도구>#<해시>` | `V1` | 외부 API 응답 | 6시간 |
| `RL#<IP>` | `MIN#<분>` / `DAY#<날짜>` | 레이트리밋 카운터 | 짧음 |

날짜 키는 **KST 기준**입니다 (`CHAT_LOG_TZ_OFFSET_HOURS=9`).

---

## 2. 백엔드 파일별 역할 (4,671줄)

### 진입점 · 에이전트

| 파일 | 줄 | 역할 |
|---|---|---|
| `src/index.mjs` | 737 | 라우팅 · 두 핸들러(`handler` 스트리밍 / `bufferedHandler` API GW) · 헬스체크 · 오리진 검증 |
| `src/agent.mjs` | 455 | 도구 호출 루프 · 시간 예산 · 부분 실패 허용 · Bedrock 오류 해설 |
| `src/prompt.mjs` | 186 | 시스템 프롬프트 (역할·추천 원칙·언어 규칙·형식) |

### 라이브러리

| 파일 | 줄 | 역할 |
|---|---|---|
| `lib/policy.mjs` | 366 | 규칙 기반 + LLM 판정 2단 입력 검사 |
| `lib/http.mjs` | 199 | 타임아웃·재시도·User-Agent 공통 fetch |
| `lib/config.mjs` | 198 | 환경변수 + SSM 비밀값 로딩(5분 캐시) |
| `lib/chatlog.mjs` | 156 | 대화 기록 저장 · `logRef` 생성/검증 |
| `lib/sessions.mjs` | 118 | 세션 히스토리 읽기/쓰기 |
| `lib/feedback.mjs` | 98 | 답변 평가 저장 (조건부 `UpdateItem`) |
| `lib/isbn.mjs` | 91 | ISBN-10 → ISBN-13 변환 · 후보 수집 |
| `lib/ratelimit.mjs` | 88 | 분당·일별 카운터 |
| `lib/cache.mjs` | 76 | DynamoDB 캐시 래퍼 |
| `lib/log.mjs` | 68 | 구조화 JSON 로그 |
| `lib/ddb.mjs` | 38 | DocumentClient · TTL 헬퍼 |

### 도구 (LLM이 호출)

| 파일 | 줄 | 역할 |
|---|---|---|
| `tools/index.mjs` | 576 | 도구 4종 정의 + 스키마 + 소스 조합 |
| `tools/merge.mjs` | 324 | ISBN-13 조인 · 필드 우선순위 · 정렬 · LLM용 압축 |
| `tools/openLibrary.mjs` | 224 | Open Library (키 불필요) |
| `tools/aladin.mjs` | 193 | 알라딘 국내 도서 |
| `tools/hardcover.mjs` | 177 | Hardcover GraphQL (무드·평점) |
| `tools/gutendex.mjs` | 164 | Gutendex 무료 전문 |
| `tools/googleBooks.mjs` | 139 | Google Books |

### 도구 4종

| 도구 | 언제 | 소스 |
|---|---|---|
| `search_books` | 제목·저자·키워드 | Google Books + Open Library + Hardcover (+ 한글이면 알라딘) |
| `browse_by_subject` | 주제·기분 | Open Library subject + Hardcover mood + Google Books (+ `language='ko'` 면 알라딘) |
| `find_free_ebooks` | 무료로 읽을 책 | Gutendex → 실패 시 Open Library 무료전문 + Hardcover 보강 |
| `get_book_detail` | 특정 한 권 | 전체 소스 (+ 한글 제목·ISBN 이면 알라딘) |

### API 엔드포인트 5개

| 경로 | 메서드 | 용도 |
|---|---|---|
| `/api/chat` | POST | 채팅 (SSE 또는 버퍼 JSON) |
| `/api/feedback` | POST | 답변 평가 |
| `/api/health` | GET | 진단 (리전·모델·DDB·키·`problems`·`warnings`) |
| `/api/config` | GET | 예시 질문 (언어별) |
| `/api/guard` | POST | 정책 판정 단독 호출 (GuardBench 연동) |

### 환경변수 24개

```
ALADIN_TTB_KEY  ALLOWED_ORIGINS  AWS_REGION  BEDROCK_MODEL_ID  BEDROCK_REGION
BOOKBOT_LOCAL  CHAT_LOG_ENABLED  CHAT_LOG_SAVE_IP  CONTACT_EMAIL
EXTERNAL_API_RETRIES  EXTERNAL_API_TIMEOUT_MS  GOOGLE_BOOKS_API_KEY
GOOGLE_BOOKS_COUNTRY  GUTENDEX_BASE_URLS  GUTENDEX_TIMEOUT_MS  HARDCOVER_TOKEN
LOG_LEVEL  POLICY_BLOCK_VALUE
POLICY_FAIL_CLOSED  POLICY_LLM_CHECK  SSM_PREFIX  TABLE_NAME
```

기본 한도: 분당 10회 · 하루 150회 · 도구 반복 4회 · 에이전트 예산 18초(API GW 모드).

---

## 3. 프론트엔드 파일별 역할 (소스 2,024줄 + 검증 스크립트 292줄)

| 파일 | 줄 | 역할 |
|---|---|---|
| `src/App.jsx` | 431 | 상태·SSE 이벤트 누적·테마·언어·읽을 목록 토글 |
| `src/i18n.js` | 391 | EN/KO 사전 88키 · `useSyncExternalStore` |
| `src/components/BookCard.jsx` | 222 | 표지·평점·무드·무료 링크·외부 링크·저장 버튼 |
| `src/lib/savedBooks.js` | 221 | 읽을 목록 저장소 (localStorage) |
| `src/api.js` | 192 | SSE 파싱 + 버퍼 JSON 폴백 · 평가 전송 |
| `src/components/ChatWindow.jsx` | 146 | 대화 렌더 · 스크롤 앵커 |
| `src/components/MessageBubble.jsx` | 114 | 답변 마크다운 렌더 |
| `src/components/Composer.jsx` | 92 | 입력창 · 글자수 · 중단 |
| `src/components/SavedPanel.jsx` | 69 | 읽을 목록 화면 |
| `src/components/Feedback.jsx` | 67 | 좋음/아쉬움 |
| `src/components/ToolActivity.jsx` | 38 | 도구 진행 표시 |
| `src/components/SuggestionChips.jsx` | 31 | 예시 질문 |
| `src/styles.css` | — | 유럽 편집 디자인 · 낮/밤 테마 |

### i18n 키 그룹 (EN/KO 각 88개, 완전 대칭)

`card` 19 · `saved` 14 · `diag` 10 · `err` 8 · `composer` 7 · `fb` 6 · `chat` 5 ·
`tools` 4 · `theme` 4 · `empty` 3 · `stats` 2 · `msg` 2 · `app` 2 · `lang` 1 · `chips` 1

---

## 4. 인프라 스크립트 20개

### 배포 순서

| 스크립트 | 하는 일 |
|---|---|
| `00-preflight.sh` | 배포 전 사람이 할 일이 끝났는지 확인 |
| `01-backend.sh` | DynamoDB → SSM → IAM → Lambda → (함수 URL) |
| `02-frontend.sh` | S3 비공개 버킷 → Vite 빌드 → 업로드 |
| `03-cloudfront.sh` | OAC 2개 → 배포(오리진 2개) → 버킷 정책 → 무효화 |
| `04-guardrails.sh` | WAF → SNS → CloudWatch 알람 → Budgets |
| `05-apigateway.sh` | HTTP API 전환 (함수 URL 대안) |

### 운영 · 도구

| 스크립트 | 하는 일 |
|---|---|
| `update.sh` | 코드 갱신 한 방 (seed-state → 백엔드 → 프론트 → 무효화 → doctor) |
| `verify.sh` | 배포 검증 (채팅·평가·보안·레이트리밋 실제 호출) |
| `doctor.sh` | 진단 + 자동 수정 |
| `seed-state.sh` | AWS 실제 상태에서 `.state` 복원 |
| `deploy-all.sh` / `go.sh` | 전체 배포 |
| `destroy.sh` | 전체 삭제 |
| `bundle-for-cloudshell.sh` | CloudShell 업로드 번들 생성 |
| `print-domain.sh` | 사이트 도메인 한 줄 출력 |
| `select-model.sh` / `bedrock-probe.sh` / `list-models.sh` | 모델 확인·선택 |
| `mfa-login.sh` / `setup-credentials.sh` | 자격증명 문제 대응 |
| `config.sh` | 공통 설정·헬퍼 (전 스크립트가 source) |

---

## 5. 검증 자산 166건

| 명령 | 건수 | 네트워크 | 무엇을 지키는가 |
|---|---|---|---|
| `npm run check` | 25파일 | 없음 | 문법 **+ 모듈 로드**. `node --check` 는 템플릿 리터럴이 끊긴 코드를 통과시킵니다 |
| `npm run test:policy` | 98 | 없음 | 미성년 안전 절대선 · 성인 문학 허용 · 인코딩 우회 · 의도 3분류 |
| `npm run test:agent` | 26 | 없음 | 도구 루프 무한 방지 · 부분 실패 허용 · 도구 마감 · **Bedrock 턴 마감** |
| `npm run test:features` | 192 | 없음 | 카드 선별 · 제목 추출 · ISBN 병합 · 장르 정렬 · `logRef` 위조 차단 |
| `npm run smoke` | 14 | **있음** | 외부 API 연결 · ISBN 병합 (5건은 키·플래그 필요로 skip) |
| `npm run test:saved` | 30 | 없음 | 다국어 중복 판정 · 상한 보존 · 시크릿 모드 |
| `npm run check:render` | 38 | 없음 | **마크다운 렌더** · 평가 버튼 표시 조건 · 축소 데이터 카드 |

합계 **398건**. `smoke` 만 외부 서버 상태에 따라 흔들립니다(4회 중 1회 실패 관측).
나머지는 항상 같은 결과입니다.

`check` 가 로드까지 하는 이유는 실제로 놓친 사고가 있어서입니다. 시스템 프롬프트는
템플릿 리터럴인데 그 안에 백틱을 하나 쓰면 문자열이 거기서 끊기고 뒤의 마크다운이
코드로 해석됩니다. 문법은 유효하니 `node --check` 는 통과하고, Lambda 는 첫 요청에서
`ReferenceError` 로 죽습니다. 지금은 전 모듈을 import 하고 프롬프트 길이까지 봅니다.

---

## 6. 작업 이력 (시간순)

### 1차 — 기반 구축

- 단일 테이블 DynamoDB 설계 (세션·기록·캐시·레이트리밋 4종)
- Bedrock `ConverseStream` + 도구 호출 루프
- 도서 API 4종 연동 + ISBN-13 조인 병합
- **이중 채널** — 카드용 원본은 프론트로, LLM에는 압축본만 (61,780자 → 779자, 99% 절감)
- SSE 스트리밍 + 버퍼 JSON 양쪽 지원
- 유럽 편집 디자인 · 낮/밤 테마 · EN/KO 다국어

### 2차 — 보안 · 가드레일

- 규칙 + LLM 2단 정책 검사 (프롬프트 인젝션·PII·유해·금지어)
- 성인 문학 허용 + `MINOR_SAFETY` 절대 차단선 신설 (이후 5차에서 주제 검열 자체를 폐기)
- 앱 레이트리밋 + WAF + 오리진 비밀
- GuardBench 연동용 `/api/guard`

### 3차 — 장애 대응

- **흰 화면 사고**: 동적 여유공간(spacer) 계산이 첫 질문에서 474px 빈칸을 만들었습니다.
  spacer를 폐기하고 "새 질문 시 한 번만 상단 고정"으로 단순화.
- **핸들러 되돌림 사고**: API Gateway 전환 후 배포 스크립트가 핸들러를 스트리밍으로
  되돌려 500. `01-backend.sh` 가 API 존재를 감지해 `bufferedHandler` 로 맞추게 수정.
- **환경변수 소실 사고**: 번들에 `secrets.env` 가 없어 `BEDROCK_MODEL_ID` 가 빈 값으로
  덮였습니다. 비면 기존 Lambda 값을 유지하도록 수정.
- **504 사고**: 반복 횟수만 제한해서 반복당 시간이 통제되지 않았습니다.
  `AGENT_BUDGET_MS` 시간 예산 도입.

### 4차 — 서비스 개선 4종 (12단계)

| # | 작업 |
|---|---|
| 1 | 채팅 기록이 자기 위치(`logRef`)를 반환 |
| 2 | `POST /api/feedback` + 조건부 `UpdateItem` |
| 3 | `tools/aladin.mjs` 어댑터 |
| 4 | 알라딘을 도구 3곳에 연결 + SSM 키 경로 |
| 5 | `lib/savedBooks.js` 저장소 |
| 6 | 카드 저장 버튼 + 읽을 목록 화면 |
| 7 | 평가 버튼 프론트 연결 |
| 8 | i18n `saved.*` 14 + `fb.*` 6 (EN/KO) |
| 9 | 신규 스타일 (편집 디자인 유지) |
| 10 | 회귀 테스트 144건 |
| 11 | 문서 갱신 (03·05·02) |
| 12 | 빌드 · 번들 · 배포 지시서 |

### 5차 — 전체 검수 (결함 9건 수정)

| 심각도 | 결함 | 수정 |
|---|---|---|
| 높음 | `verify.sh` 가 SSE만 파싱 → **정상 배포가 4건 실패로 표시** | 두 형태 정규화. 6가지 응답으로 검증 |
| 높음 | `verify.sh` 가 `SITE_URL` 없으면 즉사 (`SKIP_DOCTOR=1` 경로) | 배포 도메인에서 복원 |
| 높음 | `01-backend.sh` 함수 URL 실패 시 `die` → 백엔드만 갱신된 어긋난 상태 | API GW 모드면 건너뜀 |
| 중간 | 평가·알라딘이 검증 대상에서 누락 | `verify.sh` 에 평가 호출 + 위조 거부 확인 추가 |
| 중간 | `doctor.sh` SSM 검사에 알라딘 키 없음 | 추가 (키 누락은 경고로 분류) |
| 중간 | 헬스체크가 알라딘 키 상태를 안 보여줌 | `secrets.ALADIN_TTB_KEY` + `warnings` 배열 신설 |
| 낮음 | 헤더 조작부 4개가 좁은 화면에서 넘침 | 접힘 허용 + 620px 이하 구분선 제거 |
| 낮음 | 평가 버튼 높이 21px (최소 24px 미달) | `min-height` + 터치 기기 여백 확대 |
| 낮음 | 읽을 목록에서 빈 바닥글이 괘선만 남김 | 렌더 제외 + 머리말 sticky |
| 낮음 | `badge--audio` 색 규칙 누락 | 추가 |

### 6차 — 답변 품질 · 카드 보장 (로그로 진단)

이 회차는 **추측으로 고치다 두 번 틀린 뒤 로그를 근거로 다시 잡은** 기록입니다.
그 과정 자체가 남길 가치가 있어 순서대로 적습니다.

**먼저 사용자 신고 두 건**

| 신고 | 원인 | 수정 |
|---|---|---|
| 답변에 `##` 가 글자로 그대로 보임 | `prompt.mjs` 는 모델에게 `## 헤딩` 을 쓰라고 지시하는데 `MessageBubble.jsx` 의 파서에 **헤딩 분기가 없었음**. 목록·빈줄·나머지 문단, 셋뿐 | 파서 재작성 — 헤딩·수평선·번호목록(`<ol>`)·표·인용문·코드블록·소프트 줄바꿈. 라이브러리 없이 유지(번들 +3KB) |
| 답변에 나온 책에 카드가 없음 | 보충 조회용 `extractTitles` 가 `《》`·이탤릭만 보고 **`**굵게**` 를 배제**했는데, 정작 프롬프트가 "굵게 표시한 제목"을 지시하고 있었음 | `《》`(신뢰) / 굵게 / 이탤릭 / 줄머리 `제목 — 저자` 4패턴. 신뢰 아닌 패턴만 이름표·문장 검사 |

**프롬프트 모순 3건** — 전 회차에 "10권 이상"을 넣으면서 옛 지시를 지우지 않은 탓입니다.

| 충돌 | 결과 |
|---|---|
| `3~4권을 추천하세요` vs `가능하면 10권 이상` | 모델이 앞쪽을 따름 |
| `한국어 400~600자` vs 10권 | 10권이 물리적으로 안 들어감 |
| `굵게 표시한 제목` vs 예시의 `《제목》` | 카드 매칭이 갈림 |

**여기서 로그를 봤고, 진단이 뒤집혔습니다.**

```
카드 선별  total 18 → presented 8    total 40 → presented 8
          total 24 → presented 5    total 25 → presented 5
bedrock turn 완료  outputTokens 1129 / 상한 3072,  totalMs 16702
```

- 후보는 **18~40권**씩 넉넉히 들어옵니다. 검색 커버리지는 병목이 아닙니다.
  → 준비하던 "다각도 병렬 검색"은 `total` 만 늘리고 `presented` 는 그대로일 것이라
    **착수 전에 폐기**했습니다.
- `outputTokens 1129 / 3072` → 토큰 상한 문제도 아닙니다. 모델이 스스로 멈춥니다.
- `totalMs 16702` / 1129토큰 → **초당 68토큰**. 권당 125~225토큰을 쓰고 있어서
  그 밀도로 10권을 쓰면 13초가 더 붙고 버퍼 응답 30초 벽을 넘습니다.
  **"10권"과 "권당 세 문장"은 애초에 양립하지 않았고, 모델은 후자를 지켰습니다.**

→ 그래서 권수를 늘리는 대신 **권당 분량을 줄였습니다.** 같은 900자로 12권을 한 줄씩
  쓰거나 5권을 세 문장씩 쓸 수 있는데, 앞쪽을 고르라고 명시했습니다. 권당 60토큰이면
  12권이 720토큰이라 지금(1129)보다 **적고 빠릅니다.**

**로그가 잡아낸 자체 회귀 3건** — 줄머리 패턴이 산문을 물고 있었습니다.

```
titles: ["직접 만들어보고 싶은지", "역사와 문화로 읽고 싶은지"]  → asked 2, got 0
titles: ["한국전쟁(6·25) 중심"]                              → asked 1, got 0
titles: ["《The Adventures of Sherlock Holmes》(셜록 홈즈의 모험)"] → 같은 책 2회 조회
```

캡처에서 겹낫표 문자를 제외하고, 같은 줄에 `《》` 가 있으면 줄머리 패턴을 쓰지 않게
하고(그 앞은 이름표), 되묻는 어미(`는지·은지·을지·인지…`)를 문장 판정에 넣었습니다.
덤으로 저자 추출 버그도 잡혔습니다 — 프롬프트가 번역 제목을 괄호로 붙이라 하는데
괄호가 저자 구분자로도 쓰여서 셜록 홈즈의 저자가 `셜록 홈즈` 로 들어가고 있었습니다.

**시간 예산 재구성**

| 결함 | 내용 |
|---|---|
| Bedrock 턴에 마감 없음 | 도구 라운드만 묶고 LLM 턴은 열려 있었음. `config.mjs` 주석의 "마무리 턴 3~8초" 는 **가정이고 코드로 강제되지 않았음** → 느린 날 504, 답변 0글자 |
| 보충 조회가 조용히 생략 | 마감이 `startedAt + 24초` 고정이라, 마무리 턴이 그 시각을 넘기면 시작 시점에 이미 마감 초과. 실측 6건 중 3건 생략(`remainingMs: -3`) |
| 재시도 설정이 어긋남 | `http.mjs` 는 "재시도 1회로 최악 10.3초" 라고 적어두었는데 `googleBooks`·`openLibrary` 가 `retries: 2` 로 덮어써 최악 16초 |

→ `REQUEST_BUDGET_MS`(26초)를 신설해 도구·LLM 턴·보충 조회를 **하나의 벽**으로 감쌌습니다.
  Bedrock 턴은 `AbortSignal` 로 끊고 **받은 텍스트는 살립니다**(`Promise.race` 는 버립니다).
  짝이 안 맞는 `toolUse` 블록은 버려 다음 호출의 `ValidationException` 을 막습니다.
  보충 조회 마감은 시작 시점 기준으로 바꿨습니다. `retries: 2` 오버라이드는 제거해
  `EXTERNAL_API_RETRIES` 하나로 전 소스가 움직입니다.

**관측 공백** — 무엇이 배포됐는지 확인할 방법이 없어 여러 번 헤맸습니다.
`/api/health` 에 `runtime` 블록을 넣어 `requestBudgetMs`·`agentBudgetMs`·
`maxToolIterations`·`maxTokens`·`responseMode`(stream/buffered)를 노출합니다.

**문서 정정** — `01-architecture.md` 가 함수 URL·스트리밍 구조로 적혀 있었습니다.
3.2절은 "API Gateway 대신 Function URL" 을 **선택 근거로 논증**하고 있었고,
4절 요청 흐름은 우리가 의도적으로 없앤 "카드 즉시 렌더" 를 설명하고 있었습니다.
실제 구조(API GW + `bufferedHandler`)와 전환 이유·대가로 다시 썼습니다.

**기타** — 평가 전송 실패 후 영구 잠김(`sent='failed'` 가 truthy), `BookCard` 의
`t` 섀도잉, 하드코딩 한국어 링크 라벨, `Composer` 글자 상한이 백엔드와 별개 상수,
`SuggestionChips` key 충돌.

---

## 7. 설계 판단 기록 (왜 그렇게 했는가)

### 데이터

- **평가를 기존 기록 항목에 속성 추가** (`UpdateItem`) — 별도 `FB#` 파티션 폐기.
  콘솔에서 `LOG#날짜` 한 번 조회로 질문·답변·평가를 한 줄에서 보려고.
- **`logRef` 를 불투명 단일 문자열로 주고받음** — pk·sk 따로 전달 폐기.
  프론트가 DynamoDB 구조를 알 필요가 없습니다.
- **`ConditionExpression: attribute_exists(pk)`** — 없는 기록에 평가만 든 빈 항목이
  생기는 것을 막습니다.
- **단일 테이블 4종** — 테이블을 4개 만들면 관리 지점이 4배가 됩니다.

### 보안

- `parseLogRef` 는 길이 80자 상한 + 엄격한 정규식으로 `LOG#` 파티션만 허용.
  `logRef` 는 브라우저를 거쳐 돌아오므로 조작 가능하고, 뚫리면 남의 세션을 훼손합니다.
- **평가에 앱 레이트리밋 미적용** — 채팅 할당량을 공유하면 평가 클릭이 대화 횟수를
  깎습니다. WAF 300회/5분이 대신 막습니다.
- 오리진 비밀(`x-origin-secret`) — CloudFront OAC + 함수 URL 조합은 본문 있는 POST를
  지원하지 않아(SigV4 서명 필요) 공개 웹앱에서 쓸 수 없습니다.

### 추천 품질

- **알라딘은 한글 질의 또는 `language='ko'` 일 때만** — 영어권 검색에 지연만 추가됩니다.
- **알라딘 캐시 키에 `wantKorean` 포함** — 소스 구성이 달라 같은 검색어도 결과가 다릅니다.
- **`parseAuthors` 로 `(지은이)` 제거** — 안 하면 병합 키가 `A:한강지은이` 가 되어
  다른 소스와 합쳐지지 않고 같은 책이 카드 2장으로 나옵니다.
- **알라딘 평점을 `RATING_PRIORITY` 맨 뒤** — `customerReviewRank` 에 표본 수가 없어
  3명의 5점과 2,000명의 4.2점을 구분할 수 없습니다.
- 표지 우선순위: `googleBooks` → `aladin` → `hardcover` → `openLibrary` → `gutendex`

### 프론트

- **읽을 목록은 localStorage 만** — 로그인을 붙이면 사용자가 떠납니다.
- **상한 초과 시 거부** — 오래된 항목 자동 삭제 폐기. 사용자 데이터를 몰래 지우지 않습니다.
- **`SavedPanel` 은 대화 영역 교체 렌더** — 모달의 포커스 트랩·스크롤 잠금·Esc·
  `aria-modal` 복잡도를 전부 회피.
- **`useSyncExternalStore`** — Context·개별 `useState` 폐기. 여러 컴포넌트가 같은
  데이터를 보는데 어긋나면 안 되고, 트리를 감쌀 필요도 없습니다.
- **`useIsSaved`(불리언만 구독) 별도 제공** — 목록 전체를 구독하면 담을 때마다
  모든 카드가 재렌더됩니다.
- **저장 시 `shrink()`** — 권당 8KB → 280바이트.
- **평가 실패는 예외를 던지지 않음** — 부가 기능이 대화를 끊으면 안 됩니다.

### 디자인

- 브랜드 `Un Livre Pour Vous · CHOWOO` — `CHOWOO` 는 `font: inherit; color: inherit`
  으로 상표와 완전히 같은 조판.
- 웹폰트 미사용 (시스템 Didot/Iowan) — 외부 의존성 + 유럽 개인정보 이슈 회피.
- 이모지 없음 · 직각 · 머리카락 선 · 색만으로 상태를 구분하지 않음(밑줄 병용).

---

## 8. 알려진 미완 · 주의

### 구조적 한계 (설계상 남은 것)

| 항목 | 내용 |
|---|---|
| **응답이 한꺼번에 도착** | `bufferedHandler` 라 TTFB = 전체 처리 시간. 실측 빠른 질문 약 10초, 검색이 여러 번 도는 질문 25초. 그동안 빈 화면입니다. 되찾으려면 **REST API 이전 + `responseTransferMode=STREAM`** 이 필요합니다 (HTTP API 는 응답 스트리밍 미지원, 통합 타임아웃 30초도 증액 불가) |
| **추천 권수** | 프롬프트를 "깊이 대신 권수" 로 재구성했지만 **운영 검증 전**입니다. 직전 실측은 `presented 5~9`. 배포 후 `카드 선별` 로그의 `presented` 가 10 이상인지 확인해야 합니다 |
| **보충 조회 생략** | 예산을 다 쓰면 건너뜁니다. 답변을 잘라 카드를 붙이는 것보다 나은 거래라 의도한 동작이지만, 그 경우 답변에 나온 책 일부에 카드가 없습니다 |
| **국립중앙도서관 실결과** | 키는 설정됐고(`NLK_API_KEY: true`) `category=도서` 제거 + 오류 재시도를 넣었으나, 실제 결과가 0건을 벗어났는지 **로그로 확인 전**입니다 |
| **프롬프트 캐싱 미적용** | 시스템 프롬프트 10,024자를 라운드마다 다시 보냅니다(실측 `inputTokens 24273`). 도입하면 지연이 줄지만 `SYSTEM_PROMPT + intentDirective` 문자열 결합을 블록 분리로 바꿔야 캐시가 깨지지 않습니다 |
| **버전 관리 없음** | `.git` 이 없어 커밋 이력이 전혀 없습니다. Lambda 는 버전을 발행하지 않고 S3 는 버저닝이 꺼져 있어 **되돌릴 지점이 없습니다.** 마무리 전에 `git init` + 최초 커밋을 권합니다 |

### 운영 잔여 작업

| 항목 | 상태 |
|---|---|
| `ALERT_EMAIL` | 넣은 뒤 확인 메일의 `Confirm subscription` 클릭 필요 |
| WAF | `04-guardrails.sh` 실행 여부 미확인 |
| CloudWatch 대시보드 | 없음 |
| 잔여 리소스 | CloudFront `DISTRIBUTION_ID_MASKED`, S3 `bookbot-web-20260827-…-an` |
| GitHub Actions 배포 | 보류 (`workflow_dispatch` 만 남김) |
| API 이름 의존 | 핸들러 결정이 `bookbot-http-api` 라는 **이름**에 의존. 이름이 바뀌면 스트리밍 핸들러로 되돌아가 API GW 환경에서 즉시 500 |
| 레이트리밋 | 분당 10 / 일 150. 심사자 여러 명이 동시에 보면 일 150 에 걸릴 수 있습니다 |

> 도서 API 키 4종(`ALADIN_TTB_KEY` · `NLK_API_KEY` · `GOOGLE_BOOKS_API_KEY` ·
> `HARDCOVER_TOKEN`)은 **전부 설정 완료**입니다. `/api/health` 의 `warnings` 가 빈 배열이면
> 정상입니다.

---

## 9. 문서 지도

| 문서 | 내용 |
|---|---|
| [01-architecture.md](./01-architecture.md) | 아키텍처 설계 |
| [02-aws-console-setup.md](./02-aws-console-setup.md) | 콘솔 단계별 설정 |
| [03-external-apis.md](./03-external-apis.md) | 도서 API 5종 키 발급·연동 |
| [04-cost-and-cleanup.md](./04-cost-and-cleanup.md) | 비용 산정·삭제 |
| [05-runbook.md](./05-runbook.md) | 운영 런북 (평가 조회·회귀 테스트) |
| [06-deploy-now.md](./06-deploy-now.md) | 실행 플레이북 |
| [07-security-and-guardrails.md](./07-security-and-guardrails.md) | 보안·가드레일 |
| [08-guardbench.md](./08-guardbench.md) | GuardBench 연동 |
| **09-work-log.md** | **이 문서 — 전체 작업 기록** |
| [10-summary.md](./10-summary.md) | 한눈에 보는 정리 |
| [11-service-and-aws.md](./11-service-and-aws.md) | 서비스 기능 · AWS 활용 · 특징 |
