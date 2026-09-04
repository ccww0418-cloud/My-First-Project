# BookBot — AWS 서버리스 책 추천 챗봇

대화로 취향을 파악해 책을 추천하는 챗봇. AWS 콘솔 실습 프로젝트 (2주 운영 기준).

**핵심 차별점:** LLM이 책을 추천하지 않습니다.
LLM은 "왜 이 책이 당신에게 맞는지"만 설명하고, **책 데이터는 4개의 실제 도서 API에서만** 가져옵니다.
그래서 존재하지 않는 책이나 틀린 저자명이 나오지 않습니다.

```
┌──────────────────────────────────────────────────────────────────┐
│  사용자 → CloudFront ─┬─→ S3 (React 정적 빌드)                    │
│                       └─→ Lambda (스트리밍) → Bedrock (Claude)     │
│                                    ↓                              │
│                    ┌───────────────┴─────────────────┐            │
│              DynamoDB          SSM              도서 API 4종        │
│           (세션/캐시/제한)    (API 키)    ┌────────────────────┐    │
│                                          │ Google Books       │    │
│                                          │ Open Library       │    │
│                                          │ Project Gutenberg  │    │
│                                          │ Hardcover          │    │
│                                          └────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 배포 방법 두 가지

### A. CLI 자동 배포 (빠름 — 약 5분)

```bash
aws configure                                 # 자격증명 1회 설정
cp infra/secrets.env.example infra/secrets.env # 모델 ID + 도서 API 키 입력
bash infra/00-preflight.sh                     # 사전 점검
bash infra/deploy-all.sh                       # 전체 배포
bash infra/verify.sh                           # 검증
```

전부 idempotent해서 실패한 지점을 고친 뒤 다시 실행하면 됩니다.
자세한 내용: **[infra/README.md](./infra/README.md)**

### B. 콘솔 수동 배포 (학습용 — 3~4시간)

각 리소스가 왜 필요하고 어떤 설정이 무슨 의미인지 익히려면 이 쪽을 권합니다.
**[docs/02-aws-console-setup.md](./docs/02-aws-console-setup.md)** (STEP 0~14)

> 어느 쪽을 택하든 **Bedrock 모델 액세스 승인**과 **도서 API 키 발급**은
> 콘솔/웹에서 직접 해야 합니다 (사용 사례 양식은 API가 없습니다).

---

## 문서 — 읽는 순서

### 처음 읽는 순서

| 순서 | 문서 | 내용 |
|---|---|---|
전체 지도는 **[docs/README.md](./docs/README.md)** 에 있습니다.

| 순서 | 문서 | 내용 |
|---|---|---|
| 0 | **[docs/10-cheatsheet.md](./docs/10-cheatsheet.md)** | 로직 1페이지 + AWS 1페이지. 여기서 시작 |
| 1 | **[docs/01-architecture.md](./docs/01-architecture.md)** | 아키텍처와 설계 근거. 왜 이 조합인지 |
| 2 | **[docs/03-external-apis.md](./docs/03-external-apis.md)** | 도서 API 6곳 키 발급 + 연동 전략 |
| 3 | **[docs/02-aws-console-setup.md](./docs/02-aws-console-setup.md)** | AWS 콘솔 단계별 설정 (STEP 0~14) |
| 3' | **[infra/README.md](./infra/README.md)** | CLI 자동 배포 스크립트 |
| 4 | **[docs/04-cost-and-cleanup.md](./docs/04-cost-and-cleanup.md)** | 비용 추정 + 2주 후 삭제 순서 |
| 5 | **[docs/05-runbook.md](./docs/05-runbook.md)** | 배포·재배포, 트러블슈팅, 모니터링, 답변 평가 조회 |

### 전체를 파악하려면

| 문서 | 누가 읽으면 좋은가 |
|---|---|
| **[docs/09-summary.md](./docs/09-summary.md)** | 처음 보는 사람. 기능·AWS 설정값·품질 개선을 한자리에 |
| **[docs/06-security.md](./docs/06-security.md)** | 보안 통제 목록과 그 값을 고른 근거 |
| **[docs/08-history.md](./docs/08-history.md)** | 유지보수 담당. 판단이 뒤집힌 기록과 배운 것 |
| **[docs/07-guardbench.md](./docs/07-guardbench.md)** | 외부 벤치마크 연동 계약 |

> 💡 **예산 알림을 가장 먼저 설정하세요.** CLI 배포는 `04-guardrails.sh`가 자동으로 만듭니다.

---

## 빠른 시작 (30분: 도서 API 검증까지)

```bash
# Node.js 22 (macOS)
brew install node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# 1) 도서 API 키 2개 발급 → docs/03-external-apis.md 참고
#    - Google Books: Google Cloud Console
#    - Hardcover:    hardcover.app/account/api

# 2) 외부 API 연결 검증 (AWS 없이 가능)
cd backend
npm install
export GOOGLE_BOOKS_API_KEY="AIza..."
export HARDCOVER_TOKEN="eyJ..."
npm run smoke

# 3) 프론트엔드 빌드 확인
cd ../frontend
npm install
npm run build

# 4) 여기까지 통과하면 AWS 콘솔 설정 시작
#    → docs/02-aws-console-setup.md
```

---

## 사용 리소스

| 서비스 | 용도 | 2주 비용 |
|---|---|---|
| **Amazon Bedrock** | Claude (ConverseStream + tool use) | $3 ~ $51 |
| **AWS Lambda** | API 서버 (Node.js 22 / arm64 / 응답 스트리밍) | ~$0.2 |
| **Amazon DynamoDB** | 단일 테이블: 세션 / 캐시 / 레이트리밋 (TTL) | ~$0.05 |
| **Amazon S3** | React 정적 파일 (비공개, OAC로만 접근) | ~$0.01 |
| **Amazon CloudFront** | 단일 진입점 (`/*`→S3, `/api/*`→Lambda) | $0 ~ $0.5 |
| **SSM Parameter Store** | 도서 API 키 (SecureString) | $0 |
| **AWS WAF** | 레이트 기반 차단 | ~$3.5 |
| **CloudWatch** | 로그 / 지표 / 알람 | ~$0.2 |
| | **합계** | **$8 ~ $56** |

자세한 계산과 시나리오별 추정은 [04-cost-and-cleanup.md](./docs/04-cost-and-cleanup.md).

---

## 이 프로젝트에서 배우는 것

**AWS**
- Bedrock Converse API + tool use (function calling), 교차 리전 추론 프로필
- Lambda 응답 스트리밍 (`RESPONSE_STREAM`) + Function URL
- CloudFront 다중 오리진 + OAC (S3 + Lambda 양쪽)
- DynamoDB 단일 테이블 설계 + TTL + 원자적 카운터
- IAM 최소 권한 정책 (`kms:ViaService` 조건 등)
- 4중 비용 방어: 앱 레이트리밋 → WAF → 예약 동시성 → Budgets

**애플리케이션 설계**
- LLM 환각 차단: 데이터는 API에서, 설명만 LLM이
- 이중 채널 패턴: LLM에는 압축 요약, 프론트에는 전체 레코드 (**토큰 99% 절감** 실측)
- 다중 소스 병합: ISBN-13 정규화 + fuzzy 매칭
- 부분 실패 허용: `Promise.allSettled`로 4개 API 중 하나가 죽어도 서비스 유지
- 외부 의존성 장애 대응: Gutendex 다운 시 Open Library 자동 폴백

---

## 디렉터리

```
0827/
├── README.md                    ← 이 파일
├── docs/                        ← 가이드 10편 + 지도
├── backend/
│   ├── src/
│   │   ├── index.mjs            Lambda 엔트리 (스트리밍 + 버퍼 양쪽 지원)
│   │   ├── agent.mjs            Bedrock ConverseStream + 도구 루프
│   │   ├── prompt.mjs           시스템 프롬프트 ← 품질은 여기서 결정됩니다
│   │   ├── tools/               도구 스펙 + 도서 API 4종 + 병합 로직
│   │   └── lib/                 설정·캐시·세션·레이트리밋·HTTP·ISBN·로깅
│   └── scripts/
│       ├── build.sh             Lambda zip 패키징
│       ├── list-models.sh       사용 가능한 Bedrock 모델 ID 확인
│       └── local-test.mjs       스모크 테스트 (AWS 없이 도서 API 검증)
└── frontend/
    └── src/
        ├── App.jsx              상태 관리 + SSE 이벤트 처리
        ├── api.js               SSE 스트리밍 클라이언트 (JSON 폴백 포함)
        └── components/          ChatWindow / BookCard / ToolActivity / Composer
```

---

## 현재 상태 (검증된 것 / 검증 못 한 것)

정직하게 구분해서 적습니다.

### ✅ 로컬에서 실제로 확인한 것
- 전체 백엔드 파일 문법 검사 통과 (`node --check`)
- 프론트엔드 프로덕션 빌드 성공 (157KB / gzip 52KB)
- Lambda 배포 zip 생성 (1.7MB — 콘솔 업로드 한도 50MB 이내)
- Open Library 검색 / 주제 탐색 / 무료 전문 검색 정상
- ISBN-10 ↔ ISBN-13 변환 및 체크섬 검증 정상
- 다중 소스 병합 + LLM용 압축 정상 (**62,598자 → 812자, 99% 절감**)
- **ISBN-13 조인으로 소스 간 병합 확인** — 서로 다른 API의 같은 책이 하나로 합쳐짐
- Gutendex 정상 조회 + EPUB/TXT 다운로드 링크 파싱 확인
- **Gutendex 장애 시 Open Library 폴백 동작 확인** —
  개발 중 gutendex.com이 실제로 다운(301 후 무응답, 503)되었다가 복구되는 것을
  관찰했고, 양쪽 경로를 모두 검증했습니다. `/books` → `/books/` (trailing slash)
  수정이 리다이렉트 홉을 제거해 안정성을 크게 높였습니다.

### ⚠️ 실제 배포 후 확인이 필요한 것
- **Bedrock 호출** — AWS 자격증명과 모델 액세스가 필요해서 로컬 검증 불가.
  `TEST_BEDROCK=1 npm run smoke`로 테스트할 수 있게 준비해뒀습니다.
- **Google Books / Hardcover** — API 키가 있어야 검증됩니다. 키 없이는 SKIP됩니다.
- **CloudFront를 경유한 SSE 스트리밍** — 캐싱·압축을 끄면 동작하는 것이 일반적이지만,
  이 조합(CloudFront → OAC → Lambda URL → SSE)을 보장하는 AWS 공식 문서를 찾지 못했습니다.
  안 되는 경우의 **플랜 A/B를 문서와 코드에 준비**해뒀습니다
  ([02-aws-console-setup.md STEP 10](./docs/02-aws-console-setup.md)).

### 🔓 알려진 제약
- **로그인이 없습니다.** URL을 아는 누구나 사용할 수 있습니다.
  레이트리밋(IP 기준) + WAF + 예약 동시성 + 예산 알림으로 4중 방어했지만,
  외부에 널리 공개하려면 Cognito를 붙이세요 (STEP 14).
- **한국어 도서 커버리지 한계.** Google Books가 한국 도서를 가장 잘 잡지만,
  Hardcover의 무드 태그는 영미권 도서에 편중되어 있습니다.
  국내 도서 위주 서비스라면 알라딘/네이버 도서 API 추가를 검토하세요.
- **gutendex.com은 간헐적으로 불안정합니다.** 개발 중 다운 → 복구를 실제로 목격했습니다.
  폴백(Open Library / Internet Archive)이 있어 기능은 유지되지만,
  EPUB/TXT **직접 다운로드 링크**는 Gutendex가 살아 있을 때만 제공됩니다.
  2주 내내 안정적으로 가려면 Gutendex 자체 호스팅이 정답입니다
  ([03-external-apis.md 4-D](./docs/03-external-apis.md)) — 확장 과제로 좋은 주제입니다.

---

## 라이선스 / 데이터 출처

이 프로젝트는 아래 서비스의 공개 API를 이용합니다. 각 서비스의 이용 약관을 확인하세요.

- [Google Books API](https://developers.google.com/books) — Google Cloud 이용 약관
- [Open Library](https://openlibrary.org/developers/api) — Internet Archive. User-Agent에 연락처 명시 요구
- [Project Gutenberg](https://www.gutenberg.org/) / [Gutendex](https://gutendex.com/) — 퍼블릭 도메인 도서
- [Hardcover](https://docs.hardcover.app/) — 커뮤니티 도서 데이터
