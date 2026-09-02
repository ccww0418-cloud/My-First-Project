# 01. 아키텍처 설계

## 1. 서비스 정의

**BookBot** — 대화로 취향을 파악해서 책을 추천하는 챗봇.

일반 LLM 챗봇과 다른 점은 **추천하는 책이 실제로 존재하는 책이라는 걸 외부 도서 API로 검증한다**는 것입니다.
LLM이 혼자 책을 추천하면 존재하지 않는 제목/저자/ISBN을 만들어내는 일이 흔합니다(환각).
그래서 이 프로젝트는 LLM을 "추천 이유를 설명하는 사람"으로만 쓰고,
**책 데이터는 전부 6개의 실제 API에서 가져옵니다.**

| 역할 | 담당 API | 이유 |
|---|---|---|
| **국내 도서 1차** | **알라딘** | 국내서 검색의 유일한 실질 소스. 표지·평점·판매 링크·절판 여부까지 한 번에 나옵니다 |
| **국내 도서 서지 보강** | **국립중앙도서관** | 납본 기관이라 국내 출간서가 사실상 전부 있습니다. 알라딘이 모르는 절판·구간·학술서를 채웁니다 |
| 영어권 1차 검색 / 서지 메타데이터 | **Google Books** | 커버리지 최대, 표지·카테고리·미리보기 링크 제공 |
| 주제(subject) 기반 탐색 / 판본 정보 | **Open Library** | `subjects` 태그가 풍부해 "이런 분위기의 책" 탐색에 강함. 무료 대출 가능 여부(`ebook_access`) 확인 |
| 무료 전자책 원문 | **Gutendex** (Project Gutenberg) | 퍼블릭 도메인 책의 실제 다운로드 링크(txt/epub/html)를 바로 줄 수 있음 |
| 커뮤니티 평점·무드·장르 | **Hardcover** | `moods`, `genres`, `content_warnings`, `rating` → **추천 근거**로 쓸 수 있는 유일한 소스 |

**언어에 따라 소스를 갈라 부릅니다.** 한국어 질의에 Open Library·Hardcover 를 부르면
품질이 오히려 떨어집니다. 실측: "한국 소설" → 「한국 현대 소설 연구」(소설이 아니라 연구서),
"Korea" → 여행서·한국사. 그래서 한국어는 알라딘 + 국립중앙도서관만 쓰고,
0권일 때만 Google Books 로 물러납니다.

이들을 **ISBN-13을 조인 키로 병합**해서 한 권당 하나의 통합 레코드를 만듭니다.
(자세한 연동 전략은 [03-external-apis.md](./03-external-apis.md))

---

## 2. 아키텍처 다이어그램

```
                        ┌─────────────────────────────────────────┐
                        │            사용자 브라우저                │
                        └────────────────────┬────────────────────┘
                                             │ HTTPS
                                             ▼
                        ┌─────────────────────────────────────────┐
                        │   AWS WAF (Rate-based rule, 선택)        │
                        └────────────────────┬────────────────────┘
                                             ▼
                        ┌─────────────────────────────────────────┐
                        │            CloudFront 배포               │
                        │  ┌───────────────┬──────────────────┐   │
                        │  │ Default (/*)  │  /api/*          │   │
                        │  └───────┬───────┴────────┬─────────┘   │
                        └──────────│────────────────│─────────────┘
                          OAC(S3)  │                │ x-origin-secret 헤더
                                   ▼                ▼
                    ┌──────────────────┐   ┌──────────────────────────┐
                    │  S3 (비공개)      │   │  API Gateway HTTP API     │
                    │  React 정적 빌드  │   │  통합 타임아웃 30초 (상한)  │
                    └──────────────────┘   └────────────┬─────────────┘
                                                        ▼
                                           ┌──────────────────────────┐
                                           │  Lambda bufferedHandler   │
                                           │  버퍼 응답 (스트리밍 아님)  │
                                           │  Node.js 22 / arm64       │
                                           │  타임아웃 90초 / 1024MB    │
                                           └────────────┬─────────────┘
                                                        │
                    ┌───────────────────────────────────┼────────────────────────────┐
                    ▼                    ▼              ▼                            ▼
        ┌───────────────────┐  ┌──────────────┐  ┌──────────────┐   ┌──────────────────────────┐
        │ Amazon Bedrock    │  │  DynamoDB    │  │  SSM         │   │  외부 도서 API (인터넷)     │
        │ Converse Stream   │  │  단일 테이블  │  │  Parameter   │   │  ┌────────────────────┐  │
        │ + Tool use        │  │  - 세션      │  │  Store       │   │  │ 알라딘        ─┐    │  │
        │ (Claude)          │  │  - 캐시      │  │  (SecureStr) │   │  │ 국립중앙도서관 ─┴ 한국│  │
        └───────────────────┘  │  - 레이트리밋 │  │  API 키 보관  │   │  │ Google Books  ─┐    │  │
                               │  - 채팅기록  │  └──────────────┘   │  │ Open Library  ─┼ 영어│  │
                               └──────────────┘                     │  │ Hardcover     ─┘    │  │
                                                                     │  │ Gutendex (무료전문) │  │
                                                                     │  └────────────────────┘  │
                                                                     └──────────────────────────┘
                    ┌──────────────────────────────────────────────────┐
                    │  CloudWatch Logs / Metrics / Alarms + Budgets     │
                    └──────────────────────────────────────────────────┘
```

---

## 3. 왜 이 조합인가 (설계 근거)

### 3.1 CloudFront 하나로 프론트 + API를 모두 서빙
`/*`는 S3, `/api/*`는 Lambda로 라우팅합니다. 얻는 것:

- **CORS 문제가 아예 없음** — 브라우저 입장에서 same-origin
- HTTPS 인증서 무료 (CloudFront 기본 도메인)
- WAF를 한 곳에만 붙이면 프론트/백엔드 동시 보호
- S3 버킷은 **OAC로만 접근** (완전 비공개)
- API 경로는 CloudFront가 붙이는 **`x-origin-secret` 커스텀 헤더**로 보호합니다.
  Lambda 가 `POST /api/chat` 에서 이 헤더를 검증합니다 (`index.mjs` `checkOriginSecret`).
  헤더 없이 API Gateway 엔드포인트를 직접 부르면 차단됩니다.

### 3.2 API Gateway HTTP API — 원래 의도와 실제

**원래 설계는 Lambda Function URL 이었습니다.** 응답 스트리밍이 기본이고(`RESPONSE_STREAM`),
요금이 $0 이고, 설정이 한 단계라서 챗봇에 맞았습니다.

**그런데 이 계정은 Lambda Public Access Block 이 걸려 있습니다.** 함수 URL 자체는
만들어지지만, `AuthType=NONE` 함수 URL 이 동작하려면 리소스 정책이 퍼블릭 호출
(`Principal: *`)을 허용해야 하고 그 정책이 거부됩니다. 실측으로 확인했습니다 —
함수 URL 을 직접 호출하면 **403** 이 돌아옵니다. 그래서 HTTP API 로 전환했습니다.

전환의 대가는 분명합니다.

| | Function URL (의도) | API Gateway HTTP API (실제) |
|---|---|---|
| 응답 스트리밍 | 기본 지원 | **불가.** 통합 타임아웃 30초는 증액 불가(AWS 쿼터: *Can be increased = No*)이고, 응답 스트리밍은 REST API 전용입니다 |
| 핸들러 | `src/index.handler` | `src/index.bufferedHandler` |
| 도구 반복 | 4회 | **3회** (`01-backend.sh` 가 자동으로 낮춤) |
| 도구 예산 | 60초 | **18초** |
| 요청 전체 예산 | 80초 | **26초** (30초 - 전송 여유 4초) |
| 체감 | 글이 흐름 | **답변을 다 만든 뒤 한꺼번에 도착** |

가장 큰 손실은 마지막 줄입니다. 버퍼 응답이라 TTFB = 전체 처리 시간입니다.
실측으로 빠른 질문은 약 10초, 검색이 여러 번 도는 질문은 25초까지 갑니다.
그동안 사용자는 빈 화면을 봅니다.

**스트리밍을 되찾는 방법은 두 가지고, 둘 다 이 프로젝트에서는 미적용입니다.**
1. **REST API 로 이전** + 통합의 `responseTransferMode=STREAM`.
   응답 스트리밍은 REST API 만 지원합니다. 스트림은 최대 15분까지 유지되고
   29초 제한을 우회합니다. 프론트 변경이 필요 없어 이쪽을 권합니다.
2. **함수 URL + CloudFront OAC** (`AuthType=AWS_IAM`).
   OAC 는 퍼블릭 정책이 아니라 Public Access Block 대상이 아닙니다. 다만 본문 있는
   POST 는 브라우저가 본문의 SHA256 을 `x-amz-content-sha256` 헤더로 보내야 합니다
   (Lambda 가 unsigned payload 를 지원하지 않음). 프론트 변경이 붙습니다.

HTTP API 에는 스로틀링이 내장되어 있어(초당 10 / 버스트 20) 예전 설계의 약점 하나는
오히려 메워졌습니다. 그래도 **DynamoDB 기반 IP 레이트리밋 + WAF rate-based rule**을
함께 둡니다 — 스테이지 스로틀은 전역이라 특정 IP 의 남용을 막지 못합니다.

### 3.3 DynamoDB 단일 테이블 설계
테이블 3개를 만들지 않고 `bookbot` 하나에 `pk`/`sk`로 3가지 용도를 담습니다.
콘솔 설정이 1회로 끝나고, TTL 설정도 1번만 하면 됩니다.

| 용도 | pk | sk | 주요 속성 | TTL |
|---|---|---|---|---|
| 대화 세션 | `SESSION#<uuid>` | `META` | `messages`(리스트), `updatedAt` | 24시간 |
| API 응답 캐시 | `CACHE#<sha256>` | `V1` | `payload`(JSON 문자열) | 6~24시간 |
| IP 레이트리밋 | `RL#<ip>` | `<윈도우 시작 epoch>` | `count`(원자적 ADD) | 2분 |

- **온디맨드 모드** → 미리 용량 계획할 필요 없음, 안 쓰면 0원
- **TTL** → 2주 뒤 데이터가 알아서 사라짐. 수동 정리 불필요

### 3.4 API 키는 Secrets Manager가 아니라 SSM Parameter Store
| | SSM Parameter Store (SecureString) | Secrets Manager |
|---|---|---|
| 요금 | **표준 파라미터 무료** | 시크릿당 $0.40/월 + API 호출료 |
| 자동 로테이션 | 없음 | 있음 |
| KMS 암호화 | `alias/aws/ssm`으로 무료 | 있음 |

2주짜리 실습에서 로테이션은 필요 없고, 무료가 낫습니다.
운영 서비스라면 Secrets Manager + 로테이션이 정석입니다. (이 판단 기준을 아는 게 실습의 포인트)

Lambda 컨테이너 안에서 **모듈 스코프에 5분 캐싱**해서 SSM 호출 횟수도 줄입니다.

### 3.5 Bedrock Converse API + Tool use
`InvokeModel`(모델별 JSON 포맷이 다름) 대신 **`ConverseStream`**을 씁니다.

- 모델을 바꿔도 코드가 그대로 (Claude → Nova → Llama)
- `toolConfig`로 함수 호출 스펙을 선언하면 **LLM이 어떤 API를 부를지 스스로 결정**
- 스트리밍 이벤트가 표준화되어 있음

**핵심 패턴 — 토큰 절약을 위한 이중 채널:**

```
도구 실행 결과
   ├─▶ LLM에게: 압축된 요약 (권당 ~120 토큰, 제목/저자/연도/평점/장르만)
   └─▶ 프론트엔드에게: 전체 레코드 (표지 URL, 설명, 링크, 무드 전부)
```

LLM은 판단에 필요한 최소 정보만 받고, 화면 렌더링용 데이터는 SSE 사이드 채널로
프론트에 직접 보냅니다. 이렇게 하면 입력 토큰이 3~5배 줄어들고 응답도 빨라집니다.

### 3.6 Node.js 22 / arm64 (Graviton)
- arm64는 x86_64보다 **약 20% 저렴**하고 이 워크로드에선 성능 차이 없음
- Node 22의 내장 `fetch`(undici) 사용 → HTTP 라이브러리 의존성 0
- ESM(`.mjs`) + top-level await

---

## 4. 요청 흐름 (한 번의 채팅)

```
1. 브라우저 → POST /api/chat  { sessionId, message }
2. CloudFront → x-origin-secret 헤더 부착 → API Gateway HTTP API → Lambda
3. Lambda (bufferedHandler — 아래 이벤트를 모아 마지막에 한 번에 반환):
   a. 오리진 헤더 검증                              ── 불일치 시 403
   b. IP 레이트리밋 체크 (DynamoDB 원자적 ADD)      ── 초과 시 429
   c. 정책 판정 (규칙 + 의도 3분류)                  ── BLOCK 이면 여기서 종료
   d. SSM에서 API 키 로드 (컨테이너 캐시 히트하면 스킵)
   e. DynamoDB에서 세션 히스토리 로드 (최근 12턴)
   f. Bedrock ConverseStream 호출 (toolConfig 포함)
   g. LLM이 도구 호출을 요청하면:
        - { type:"tool_start", name:"search_books" } 방출
        - 캐시 확인 → 미스면 외부 API 병렬 호출 (Promise.allSettled)
        - 언어별 소스 분기: 한국어 → 알라딘 + 국립중앙도서관
                            영어   → Google Books + Open Library + Hardcover
        - 결과 정규화 + ISBN 병합, bookMap 에 누적 (★ 아직 화면에 안 보냅니다)
        - 압축 요약을 toolResult 로 넣고 (f)로 되돌아감 — 반복 3회 / 예산 18초
   h. 최종 답변 텍스트 생성 (요청 전체 예산 26초 안에서, 초과 시 중단하고 부분 답변 사용)
   i. ★ 카드 선별 (present.mjs) — 답변 텍스트에 **제목이 언급된 책만** 고릅니다
        - 시리즈는 한 권으로 접음
        - 언급된 책이 하나도 안 잡히면 폴백 12권
   j. ★ 보충 조회 (backfillMentioned) — 답변에 나왔는데 카드가 없는 책을
        제목·저자로 정확 조회해서 채웁니다 (남은 시간 있을 때만)
   k. { type:"books", items:[...] } 방출  ← 선별이 끝난 뒤 한 번만
   l. 세션 저장 (텍스트 턴만, ttl 24h) + 채팅 기록 저장
   m. { type:"done", usage, logRef } 방출
4. 브라우저: 텍스트는 말풍선에, books 는 카드 그리드로 렌더

★ (i)(j) 가 이 프로젝트의 핵심 장치입니다. 전에는 (g)에서 찾은 책을 즉시
  화면에 보냈는데, 그러면 LLM 이 언급하지 않은 책까지 전부 카드가 됐습니다.
  실측: 카드 26장 중 23장이 답변에 없는 책이었고 「혼불」 한 작품이 6장을 차지했습니다.
  반대 방향의 문제도 있었습니다 — LLM 이 자기 지식으로 언급한 책은 카드가 없었습니다.
  (i)로 과잉을, (j)로 누락을 잡습니다.
```

---

## 5. 보안 설계

| 위협 | 대응 |
|---|---|
| **Bedrock 비용 폭탄** (누가 무한 호출) | ① DynamoDB IP 레이트리밋(분당 10회 / 일 150회) ② API Gateway 스테이지 스로틀(초당 10 / 버스트 20) ③ WAF rate-based rule ④ Lambda 예약 동시성 10 ⑤ AWS Budgets 알림 |
| S3 버킷 직접 접근 | 퍼블릭 액세스 전면 차단 + CloudFront OAC만 허용 |
| API Gateway 직접 호출 | CloudFront가 붙이는 `x-origin-secret` 헤더를 Lambda가 검증. 헤더 없는 `POST /api/chat` 은 403 (`/api/health` 는 진단 목적으로 열어둠) |
| Lambda 함수 URL 직접 호출 | 계정 Public Access Block 이 퍼블릭 리소스 정책을 거부 → 함수 URL 은 403. 실측 확인 |
| API 키 노출 | SSM SecureString. 프론트 코드/환경변수에 절대 넣지 않음 |
| 프롬프트 인젝션 | 시스템 프롬프트에 도구 결과는 데이터로만 취급하라고 명시 + 입력 길이 2000자 제한 |
| 무제한 히스토리 증가 | 최근 12턴만 유지, 메시지당 2000자 제한 |

> ⚠️ **이 구성은 로그인이 없습니다.** URL을 아는 사람은 누구나 쓸 수 있습니다.
> 2주 실습·데모 목적이라 레이트리밋 + 예산 알림으로 막는 설계인데,
> 외부에 널리 공개할 계획이면 [02-aws-console-setup.md의 STEP 11](./02-aws-console-setup.md)에서
> Cognito를 추가하세요.

---

## 6. 디렉터리 구조

```
0827/
├── README.md                      ← 시작점
├── docs/
│   ├── 01-architecture.md         ← 이 문서
│   ├── 02-aws-console-setup.md    ← 콘솔 단계별 설정 (핵심)
│   ├── 03-external-apis.md        ← 도서 API 4종 키 발급 + 연동 전략
│   ├── 04-cost-and-cleanup.md     ← 비용 산정 + 2주 후 삭제
│   └── 05-runbook.md              ← 배포/모니터링/트러블슈팅
├── backend/
│   ├── package.json
│   ├── .env.example
│   ├── scripts/
│   │   ├── build.sh               ← Lambda zip 패키징
│   │   ├── check.mjs              ← 문법 + 모듈 로드 검사 (--check 만으로는 못 잡는 것까지)
│   │   ├── list-models.sh         ← 사용 가능한 Bedrock 모델 ID 확인
│   │   ├── local-test.mjs         ← 로컬 스모크 테스트
│   │   ├── agent-loop-test.mjs    ← 도구 루프·예산·마감 (Bedrock 가짜 주입)
│   │   ├── policy-test.mjs        ← 정책·의도 분류
│   │   ├── feature-test.mjs       ← 카드 선별·제목 추출·병합·장르
│   │   └── nlk-check.mjs          ← 국립중앙도서관 실연결 확인
│   └── src/
│       ├── index.mjs              ← Lambda 엔트리 (handler=스트리밍 / bufferedHandler=버퍼)
│       ├── agent.mjs              ← Bedrock Converse + 도구 루프 + 보충 조회
│       ├── prompt.mjs             ← 시스템 프롬프트
│       ├── tools/
│       │   ├── index.mjs          ← 도구 스펙 + 디스패처 (도구 5종)
│       │   ├── aladin.mjs         ← 국내 도서 1차
│       │   ├── nlk.mjs            ← 국립중앙도서관
│       │   ├── googleBooks.mjs
│       │   ├── openLibrary.mjs
│       │   ├── gutendex.mjs
│       │   ├── hardcover.mjs
│       │   ├── lookup.mjs         ← 제목·저자 정확 조회 (보충 조회용)
│       │   ├── genre.mjs          ← 장르 사전 21종 + 주제 적합성 정렬
│       │   ├── present.mjs        ← ★ 카드 선별 (답변에 언급된 책만)
│       │   └── merge.mjs          ← ISBN 기준 다중 소스 병합
│       └── lib/
│           ├── config.mjs         ← 환경변수 + 예산 상수
│           ├── policy.mjs         ← 규칙 검사 + 의도 3분류
│           ├── ddb.mjs            ← DynamoDB 클라이언트
│           ├── cache.mjs          ← 응답 캐시
│           ├── sessions.mjs       ← 대화 세션
│           ├── chatlog.mjs        ← 채팅 기록 보관
│           ├── feedback.mjs       ← 답변 평가 저장
│           ├── ratelimit.mjs      ← IP 레이트리밋
│           ├── http.mjs           ← fetch 래퍼 (타임아웃/재시도)
│           ├── isbn.mjs           ← ISBN-10/13 정규화
│           └── log.mjs            ← 구조화 로깅
└── frontend/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    ├── .env.example
    ├── scripts/
    │   ├── render-check.jsx       ← 브라우저 없이 SSR 렌더 검수 (마크다운·카드·평가)
    │   └── saved-test.mjs         ← 읽을 목록 저장 로직
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── api.js                 ← SSE 파싱 + JSON 폴백 (버퍼 응답 대응)
        ├── i18n.js                ← 다국어 + 로케일 숫자 서식
        ├── styles.css
        ├── lib/
        │   └── savedBooks.js      ← 읽을 목록 (localStorage + 메모리 폴백)
        └── components/
            ├── ChatWindow.jsx
            ├── MessageBubble.jsx  ← 자체 마크다운 파서 (라이브러리 없음)
            ├── BookCard.jsx
            ├── SavedPanel.jsx     ← 읽을 목록 화면
            ├── Feedback.jsx       ← 답변 평가
            ├── ToolActivity.jsx
            ├── Composer.jsx
            └── SuggestionChips.jsx
```

---

## 7. 다음 단계

1. [03-external-apis.md](./03-external-apis.md) — 먼저 도서 API 키 2개를 발급받으세요 (Google Books, Hardcover)
2. [02-aws-console-setup.md](./02-aws-console-setup.md) — AWS 콘솔 설정 (STEP 0 ~ 13)
3. [04-cost-and-cleanup.md](./04-cost-and-cleanup.md) — **배포 전에** 예산 알림부터 설정
