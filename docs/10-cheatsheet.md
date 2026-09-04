# 10. 치트시트 — 서비스 로직 · AWS 기능

> 발표·복습용 압축본 · 2026-09-04
> 상세본: [09-summary.md](./09-summary.md) · [08-history.md](./08-history.md)

---

# 1부. 책 추천 로직

## 한 줄 요약

**모델은 "왜 이 책인지" 설명만 하고, 제목·저자·표지·평점·ISBN 은 전부 외부 API 에서 온다.**

```
일반 챗봇   입력 → 모델 → 출력                          모델이 아는 것을 말한다
BookBot     입력 → 검문 → 모델 ↔ 외부 DB → 검증 → 출력   외부에서 확인된 것만 말한다
```

## 흐름 6단계

```
1  문지기      오리진 비밀 · 2,000자 제한 · 세션ID · 레이트리밋
2  정책 검사   정규식 27개 → 걸리면 모델 호출 0회, 0.2초 종료
               통과하면 모델로 의도 분류 (BOOK / SERVICE / ATTACK)
3  도구 루프   모델 호출 → 도구 실행 → 결과 되돌려주기 (최대 4회)
4  검증        API 6곳 조회 → 중복 제거 → 제목·저자 대조
5  카드 선별   답변이 언급한 책만 카드로, 12장까지 채움
6  출력        SSE 전송 + DynamoDB 저장
```

## 검증 (핵심)

모델이 "《종의 기원》 정유정" 을 떠올리면 API 로 대조합니다.

```
제목 유사도 ≥ 0.7  AND  저자 유사도 ≥ 0.5  →  통과
통과 못 한 책은 답변에서 언급 금지
```

| 값 | 왜 |
|---|---|
| 제목 0.7 | 0.62였을 때 「종의 기원」에 「종의 기원과 진화론」이 0.64로 통과 |
| 저자 0.5 | 「1984」엔 해설서·만화판이 많음. 저자가 다르면 다른 책 |

대조 전 정규화: 발음기호·장식문자 제거, 조사 처리(「가와바타」가 조사 `가`로 잘림),
권차 제거(「혼불 1」→「혼불」).

환각을 프롬프트로 부탁하지 않고 **구조로 막습니다.**

## 소스 6곳 · 언어별 라우팅

```
한국어 맥락 → 알라딘 · 국립중앙도서관   (보낼 한국어 검색어가 있을 때만)
영어권      → Google Books · Open Library · Hardcover · Gutendex
0권이면     → Google Books(langRestrict=ko) 폴백
```

병합: ISBN13 중복 제거 → 유사도 2차 제거 → 필드 병합(표지 채움) → 점수 정렬 → 장르 불일치 제거

## 도구 5종

```
search_books        DB 6곳 통합 검색 (기본 14권)
browse_by_subject   주제·분위기 탐색
lookup_books        특정 책 확인  ← 장르·분위기 요청엔 이걸 먼저
find_free_ebooks    무료 전자책
get_book_detail     한 권 상세
```

## 카드 선별

```
검색 18~40권 → 시리즈 접기 → 답변에서 《》 제목 추출 → 언급된 책만 카드
             → 12장까지 채움(문자체계 맞춤) → 답변에 있는데 카드 없으면 재조회
```

한글 제목 책을 추천했으면 채우는 책도 한글로 제한합니다. 그러지 않았을 때
"위로되는 한국 소설" 요청에 캐나다 통계 자료가 카드로 나갔습니다.

## 답변 언어

프롬프트의 "사용자가 쓴 언어로 답하세요" 는 지켜지지 않았습니다.
→ 코드가 **문자체계로** 판정하고, 매 턴 **현재 입력**으로 다시 봅니다(이력 오염 차단).
지시문은 시스템 프롬프트 **맨 끝**에 붙입니다.

## 로딩 메시지

응답 스트리밍이 안 돼서 진행 이벤트가 마지막에 한꺼번에 옵니다. 기다리는 동안
알 수 있는 게 없습니다. → **모르는 걸 아는 척하지 않는다.**
경과 시간은 실측, 문구는 서버 예산에 맞춘 4단계.

```
 0초  준비하고 있어요…
 2초  여러 도서관과 서점을 찾아보고 있어요…
12초  찾은 책 중에서 골라 정리하고 있어요…
22초  거의 다 됐어요. 조금만 기다려 주세요.
```

**예산을 바꾸면 여기도 고쳐야** 합니다.

## 실측

```
전체 27초 · 외부 API 1.2초(4.5%) · 모델 4회 25.9초(95%)
토큰 입력 17,905 / 출력 670 · 카드 12장
API Gateway 30초 한계까지 여유 0.8초  ← 남은 최우선 과제
```

---

# 2부. AWS 기능

```
브라우저
  ↓ HTTPS
CloudFront ──┬─ /*      → S3        (React 정적 사이트, 버킷 완전 비공개)
   + WAF     └─ /api/*  → Lambda    (API Gateway HTTP API 경유)
                            ├ Bedrock       모델 호출
                            ├ 도서 API 6곳   외부 검증
                            ├ DynamoDB      세션·캐시·레이트리밋·기록
                            └ SSM           API 키
```

```yaml
CloudFront          : 유일한 공개 진입점. /* → S3, /api/* → Lambda. SSE 때문에 압축 끔
WAF                 : IP 기반 차단. 5분당 300회 (채팅 100회)
S3                  : React 정적 파일. 버킷 완전 비공개, OAC SigV4 로만 접근
API Gateway         : HTTP API 프록시. ANY /api/{proxy+}. 타임아웃 30초 고정(증액 불가)
Lambda              : 애플리케이션 전체. Node 22, arm64, 1024MB, 예약 동시성 10
Bedrock             : Claude Sonnet 4.6. ConverseStream(도구 사용), maxTokens 3072
DynamoDB            : 테이블 1개를 4용도로. TTL, 원자적 ADD
SSM Parameter Store : API 키 5개. SecureString, 무료, 5분 캐시
CloudWatch + SNS    : 알람 4종 (오류·스로틀·60초 초과·시간당 토큰 20만)
Budgets             : 전체 $100 / Bedrock $50
IAM                 : 최소 권한. 테이블·파라미터 경로 한정
CloudShell          : 배포 실행. 로컬 CLI 는 MFA(FIDO 전용)로 막힘
```

## DynamoDB 한 테이블 4용도

```yaml
SESSION#  : 대화 이력      TTL 24시간
LOG#      : 검토용 기록    TTL 90일
CACHE#    : 외부 API 응답  TTL 6시간
RL# RLOAI#: 레이트리밋      TTL 120초 / 25시간
```

테이블을 4개 만들면 관리 지점도 4배가 됩니다. 레이트리밋의 `ADD` 는 원자적이라
동시 요청에도 카운트가 정확합니다.

## 비용 방어 4층

로그인 없는 공개 서비스 + Bedrock 호출이라 여기가 가장 중요합니다.

```yaml
1층 : 앱 레이트리밋 (DynamoDB)  분당 10 / 하루 150
2층 : WAF rate-based           5분당 300 (채팅 100)
3층 : Lambda 예약 동시성         10
4층 : AWS Budgets              $100 / Bedrock $50
```

긴급 정지는 예약 동시성 `0` — 즉시 차단되고 값을 되돌리면 복구됩니다.

## 인증

```yaml
못 쓴 것 : 함수 URL AuthType=AWS_IAM + OAC SigV4
이유     : 본문 있는 POST 는 브라우저가 본문 SHA-256 을
           x-amz-content-sha256 로 서명해야 함 → 공개 웹앱 불가
쓴 것    : AuthType=NONE + CloudFront 가 오리진으로만 주입하는 x-origin-secret
보관     : SSM SecureString, 상수 시간 비교, 브라우저 비노출
```

## 검증

```bash
cd backend && npm run check    # 26파일 + 프롬프트 5절
npm run test:policy            # 99
npm run test:features          # 218
npm run test:openai            # 50
npm run test:agent             # 23
cd ../frontend && npm run test:saved && npm run check:render   # 30 + 54
```

합계 **474건**, 네트워크 없이 돕니다.
