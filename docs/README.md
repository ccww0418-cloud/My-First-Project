# BookBot 문서 지도

10편 · 7,700줄. **처음이면 `10` 하나만 읽으면 됩니다.**

발표용 자료는 저장소 루트에 있습니다 — [BookBot-발표자료.pptx](../BookBot-발표자료.pptx) (6장),
[aws-architecture.png](./aws-architecture.png) (인프라 구성도).

| # | 파일 | 줄 | 무엇 |
|---|---|---|---|
| **10** | [10-cheatsheet](./10-cheatsheet.md) | 185 | **로직 1p + AWS 1p.** 여기서 시작 |
| 09 | [09-summary](./09-summary.md) | 702 | 전체 정리 — 기능 · AWS 설정값 · 품질 개선 |
| 01 | [01-architecture](./01-architecture.md) | 326 | 지금 구조가 어떻게 생겼나 · 왜 이 조합인가 |
| 02 | [02-aws-console-setup](./02-aws-console-setup.md) | 1,377 | AWS 콘솔 클릭 단위 설정 (STEP 0~14) |
| 03 | [03-external-apis](./03-external-apis.md) | 1,147 | 도서 API 6곳 키 발급 · 연동 전략 |
| 04 | [04-cost-and-cleanup](./04-cost-and-cleanup.md) | 399 | 비용 산정 · 전체 삭제 순서 |
| 05 | [05-runbook](./05-runbook.md) | 1,114 | 배포 · 장애 대응 · 모니터링 · 평가 조회 |
| 06 | [06-security](./06-security.md) | 904 | 보안 통제(1부 목록 / 2부 근거) |
| 07 | [07-guardbench](./07-guardbench.md) | 463 | 외부 벤치마크 연동 계약 |
| 08 | [08-history](./08-history.md) | 1,093 | 개선 이력(1부) · 배운 것(2부) |

---

## 찾는 게 이거라면

| 알고 싶은 것 | 파일 |
|---|---|
| 이 서비스 뭐야 / 발표해야 함 | **10** |
| 기능·설정값을 다 보고 싶음 | 09 |
| 왜 이렇게 만들었나 | 01 → 08 |
| AWS 어떻게 설정했나 | 02 |
| 배포·재배포 / 터졌음 | 05 |
| 돈 얼마 드나 / 다 지우고 싶음 | 04 |
| 보안 어떻게 막았나 | 06 |
| 도서 API 키 발급 | 03 |

---

## 프롬프트 · 정책은 문서가 아니라 코드에 있습니다

프롬프트는 **두 개**입니다. `SYSTEM_PROMPT`(추천용)와 `CLASSIFIER_PROMPT`(검문용).

### `backend/src/prompt.mjs` (552줄)

| 이름 | 줄 | 무엇 |
|---|---|---|
| `SYSTEM_PROMPT` | 32 | **메인 프롬프트 10,392자** |
| `SUGGESTIONS_BY_LANG` | 408 | 첫 화면 추천 질문 |
| `detectReplyLanguage` | 474 | 답변 언어를 문자체계로 판정 |
| `languageDirective` | 538 | 프롬프트 맨 끝에 붙는 언어 지시문 |

`SYSTEM_PROMPT` 안의 절:

```
# 0. 기본 동작            무엇이 들어오든 그 주제의 책 추천
# 1. 예외                 책 추천이 아닌 "직접 해달라"
# 2. 절대 규칙
# 3. 무거운 주제 다루기
# 도구 사용 전략           ★ 장르·분위기면 lookup_books 먼저 ★
# 답변 형식               기본은 짧은 목록
# 답변은 질문에 맞아야     조건 하나하나 확인
# 대화 스타일 / 답변 길이
# 검색어 언어             품질에 직결
```

### `backend/src/lib/policy.mjs` (389줄)

| 이름 | 줄 | 무엇 |
|---|---|---|
| `INJECTION` | 78 | 프롬프트 인젝션 정규식 **18개** |
| `PII` | 110 | 개인정보 정규식 **2개** |
| `MINOR_SAFETY` | 127 | 미성년자 보호 정규식 **7개** |
| `checkRules` | 160 | 정규식 검사 (모델 호출 0회, 0.2초) |
| `CLASSIFIER_PROMPT` | 215 | **두 번째 프롬프트** — 의도 분류기 |
| `classifyIntent` | 262 | BOOK / SERVICE / ATTACK 판정 |
| `evaluatePolicy` | 338 | 정규식 + 의도 통합 판정 |
| `blockReason` | 369 | 차단 시 사용자에게 보여줄 문구 |

정책의 설계 의도(주제 검열을 왜 폐기했는지)는 [06-security.md 22절](./06-security.md).

### 고치기 전에 돌릴 것

```bash
cd backend
node scripts/check.mjs        # 프롬프트 5개 절 표지가 살아있는지
node scripts/policy-test.mjs  # 정책 99건
```

`check.mjs` 가 절 표지를 세는 이유: 프롬프트는 템플릿 리터럴이라 안에 백틱 하나가
들어가면 문자열이 거기서 끊깁니다. 문법은 유효하니 `node --check` 는 통과하고,
Lambda 가 첫 요청에서 죽습니다.

> ⚠️ 프롬프트를 "정리" 하려면 [08-history.md 1부 12절](./08-history.md)을 먼저
> 읽으세요. 82% 삭감했다가 품질 사고를 내고 되돌린 기록입니다. 근거로 삼은
> "모순 3건" 이 **이미 고쳐진 과거 기록**이었습니다.
