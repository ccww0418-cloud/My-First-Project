# 04. 비용 산정과 정리(삭제)

> ⚠️ AWS와 Bedrock 요금은 수시로 바뀝니다. 아래 숫자는 **2026년 8월 기준 추정치**이고,
> 실제 청구는 반드시 [Bedrock 요금 페이지](https://aws.amazon.com/bedrock/pricing/)와
> Cost Explorer로 확인하세요. 가정과 계산식을 그대로 적어뒀으니 숫자만 갈아 넣으면 됩니다.

## 결론부터

**확보한 100만원(약 $700)으로 2주 운영은 충분히 여유롭습니다.**
예상 총비용은 **$25 ~ $85** (약 3만 ~ 12만원)로, 예산의 **10% 이내**입니다.

단, 조건이 있습니다. 아래 3가지를 안 하면 예산을 태울 수 있습니다.

| 반드시 할 것 | 안 했을 때 |
|---|---|
| Lambda 예약 동시성 = 10 (STEP 6-G) | 동시 1000개 실행 → Bedrock 호출 폭증 |
| `MAX_TOOL_ITERATIONS` = 4 유지 | LLM이 도구를 무한 반복 → 요청당 비용 10배 |
| AWS Budgets 알림 (STEP 0) | 이상 징후를 청구서 받고 나서 알게 됨 |

---

# 1. 비용 구조 — 어디에 돈이 나가나

```
Bedrock (LLM)      ████████████████████████████████████████  85~95%
WAF                ███                                        5~10%
CloudWatch Logs    █                                           1~2%
Lambda             ▏                                          <1%
DynamoDB           ▏                                          <1%
CloudFront         ▏                                          <1%  (무료 티어)
S3                 ▏                                          <1%
SSM Parameter Store                                             0원
```

**즉, 비용 관리 = Bedrock 토큰 관리입니다.** 나머지는 신경 쓸 필요가 없습니다.

---

# 2. Bedrock 비용 계산

## 2-1. 요청 1건당 토큰 사용량

한 번의 채팅에서 Bedrock을 **2회** 호출합니다 (도구를 한 번 쓰는 일반적 경우).

```
1차 호출 (도구 선택)
  입력  = 시스템 프롬프트(약 1,200) + 도구 스펙(약 1,500) + 대화 히스토리(약 800)
        + 사용자 메시지(약 50)
        ≈ 3,550 토큰
  출력  = 도구 호출 JSON ≈ 80 토큰

2차 호출 (답변 생성)
  입력  = 1차 입력 전체 + 도구 호출 + 압축된 검색 결과(8권 × 110 ≈ 900)
        ≈ 4,530 토큰
  출력  = 최종 답변 ≈ 550 토큰

────────────────────────────────────────
합계   입력 ≈ 8,100 토큰 / 출력 ≈ 630 토큰
```

> 여기서 **압축된 검색 결과 900 토큰**이 핵심입니다.
> 전체 레코드를 그대로 넣으면 8권 × 1,200 ≈ 9,600 토큰이 됩니다.
> `compactForLlm()` 덕분에 입력 토큰이 약 **절반**으로 줍니다.
> (로컬 테스트 실측: 61,755자 → 779자, 99% 절감)

## 2-2. 사용량 시나리오별 총비용 (2주)

**단가 (2026년 8월 기준, 확인 필요):**

| 모델 | 입력 / 1M 토큰 | 출력 / 1M 토큰 |
|---|---|---|
| Claude Sonnet 4.5 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $1.00 | $5.00 |
| Amazon Nova Lite | $0.06 | $0.24 |

**시나리오 A — 개인 실습/포트폴리오 (본인 + 지인 몇 명)**
```
대화 100건 × 3턴 = 300 요청
입력 300 × 8,100 = 2.43M 토큰
출력 300 ×   630 = 0.19M 토큰

Sonnet: 2.43 × $3 + 0.19 × $15 = $7.29 + $2.85  = 약 $10
Haiku:  2.43 × $1 + 0.19 × $5  = $2.43 + $0.95  = 약 $3
```

**시나리오 B — 소규모 공개 데모 (권장 기준)**
```
대화 500건 × 3턴 = 1,500 요청
입력 1,500 × 8,100 = 12.15M 토큰
출력 1,500 ×   630 =  0.95M 토큰

Sonnet: 12.15 × $3 + 0.95 × $15 = $36.45 + $14.25 = 약 $51
Haiku:  12.15 × $1 + 0.95 × $5  = $12.15 + $4.75  = 약 $17
```

**시나리오 C — 예상보다 많이 퍼진 경우 (레이트리밋 상한까지)**
```
일 150 요청(RATE_LIMIT_PER_DAY) × 14일 × IP 5개 = 10,500 요청
입력 85M / 출력 6.6M 토큰

Sonnet: 85 × $3 + 6.6 × $15 = $255 + $99 = 약 $354  ← 예산의 절반
Haiku:  85 × $1 + 6.6 × $5  = $85 + $33  = 약 $118
```

> 시나리오 C가 예산 대비 부담스럽다면 **Haiku로 시작하세요.**
> 환경 변수 `BEDROCK_MODEL_ID` 하나만 바꾸면 됩니다 (코드 수정 없음).
> 이 프로젝트는 책 데이터를 외부 API에서 가져오므로, LLM이 하는 일은
> "왜 이 책인지 설명하기"뿐입니다. **Haiku로도 품질이 충분히 나옵니다.**

## 2-3. Bedrock 비용을 더 줄이는 방법

### ① 프롬프트 캐싱 (최대 90% 절감 — 효과가 가장 큼)

우리 입력 8,100 토큰 중 **시스템 프롬프트 + 도구 스펙 = 약 2,700 토큰이
매 요청마다 완전히 동일**합니다. 캐싱하기에 완벽한 조건입니다.

`agent.mjs`의 `ConverseStreamCommand`에 `cachePoint`를 추가하면 됩니다:

```js
// system 배열 끝에 캐시 지점 표시
system: [
  { text: SYSTEM_PROMPT },
  { cachePoint: { type: 'default' } },
],
```

> 모델별로 캐싱 지원 여부와 최소 토큰 수가 다릅니다.
> 적용 전 [프롬프트 캐싱 문서](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)에서
> 사용 중인 모델이 지원하는지 확인하세요.
> 지원 안 하는 모델에 넣으면 `ValidationException`이 납니다.

### ② 모델 다운그레이드
`BEDROCK_MODEL_ID`를 Haiku로 → 약 **3분의 1**.

### ③ 히스토리 축소
`config.limits.historyTurns`를 12 → 6으로 줄이면 입력 토큰이 감소합니다.
단 대화 맥락 유지력이 떨어집니다. (`lib/config.mjs`)

### ④ `MAX_TOOL_ITERATIONS` 축소
4 → 2로 줄이면 최악의 경우 비용이 절반이 됩니다.
대신 LLM이 검색을 재시도할 기회가 줄어 결과 품질이 떨어질 수 있습니다.

### ⑤ 캐시 TTL 연장
`CACHE_TTL_SECONDS`를 6시간 → 24시간으로. Bedrock 비용은 안 줄지만
외부 API 쿼터를 아끼고 응답이 빨라집니다.

---

# 3. Bedrock 외 비용 (2주)

시나리오 B(1,500 요청) 기준입니다.

| 서비스 | 계산 | 2주 비용 |
|---|---|---|
| **Lambda** | 1,500회 × 8초 × 1GB = 12,000 GB-초 (arm64 $0.0000133/GB-초) | **$0.16** |
| | 요청 요금 1,500 × $0.0000002 | $0.0003 |
| **DynamoDB** | 쓰기 약 15K WRU ($1.25/M), 읽기 약 15K RRU ($0.25/M) | **$0.03** |
| | 스토리지 < 50MB | $0.01 |
| **S3** | 스토리지 2MB + GET 수천 건 | **$0.01** |
| **CloudFront** | 전송 약 3GB + 요청 약 10만 건 | **$0 ~ $0.50** |
| | (무료 티어: 월 1TB 전송 + 1,000만 요청) | |
| **WAF** | Web ACL $5/월 + 규칙 2개 $2/월 → 2주분 | **$3.50** |
| | 요청 검사 $0.60/M × 0.1M | $0.06 |
| **CloudWatch Logs** | 수집 약 200MB × $0.76/GB (서울) | **$0.15** |
| | 저장 약 200MB × $0.033/GB | $0.01 |
| **SSM Parameter Store** | 표준 파라미터 2개 | **$0** |
| **KMS** | `alias/aws/ssm` 사용 (AWS 관리형 키) | **$0** |
| | | |
| **소계** | | **약 $4 ~ $5** |

> Lambda와 DynamoDB는 사실상 무료입니다. **WAF가 Bedrock 다음으로 큰 항목**입니다.
> WAF를 빼면 $1 미만이 되지만, 비용 폭탄 방지 효과를 생각하면 $3.5는 보험료로 적절합니다.

---

# 4. 총계

| 시나리오 | 모델 | Bedrock | 기타 | **합계** | 원화(≈1,400원/$) | 예산 대비 |
|---|---|---|---|---|---|---|
| A 개인 실습 | Haiku | $3 | $5 | **$8** | 약 1.1만원 | 1% |
| A 개인 실습 | Sonnet | $10 | $5 | **$15** | 약 2.1만원 | 2% |
| B 소규모 공개 | Haiku | $17 | $5 | **$22** | 약 3.1만원 | 3% |
| B 소규모 공개 | Sonnet | $51 | $5 | **$56** | 약 7.8만원 | 8% |
| C 상한까지 | Haiku | $118 | $5 | **$123** | 약 17만원 | 18% |
| C 상한까지 | Sonnet | $354 | $5 | **$359** | 약 50만원 | 51% |

**권장 출발점: Haiku + 시나리오 B 가정 → 약 3만원.**
잘 돌아가는 걸 확인한 뒤 Sonnet으로 올려서 품질 차이를 비교해보세요.
그 비교 자체가 좋은 실습입니다.

---

# 5. 운영 중 비용 감시

## 5-1. 매일 확인할 것 (2분)

**Cost Explorer**: 결제 및 비용 관리 → **Cost Explorer**
- 그룹화 기준: **서비스**
- 기간: 이번 달, 일별
- Bedrock 막대가 갑자기 튀는 날이 있는지 확인

## 5-2. 실제 토큰 사용량 조회

CloudWatch → **Logs Insights** → `/aws/lambda/bookbot-api`:

```
# 오늘 총 토큰 사용량과 요청 수
fields inputTokens, outputTokens
| filter msg = "chat 완료"
| stats count(*) as 요청수,
        sum(inputTokens) as 총입력토큰,
        sum(outputTokens) as 총출력토큰,
        avg(inputTokens) as 평균입력,
        avg(totalMs)/1000 as 평균응답초
```

이 결과에 단가를 곱하면 실제 비용을 즉시 알 수 있습니다:
```
비용 = (총입력토큰 / 1,000,000 × 입력단가) + (총출력토큰 / 1,000,000 × 출력단가)
```

```
# 요청당 입력 토큰이 예상(8,100)보다 크면 히스토리가 비대해진 것
fields @timestamp, inputTokens, outputTokens
| filter msg = "chat 완료" and inputTokens > 15000
| sort @timestamp desc
```

```
# 도구 반복 상한에 걸린 요청 (비용이 큰 요청)
fields @timestamp
| filter msg = "도구 반복 상한 도달"
| stats count(*) as 상한도달횟수 by bin(1h)
```

## 5-3. 이상 징후와 대응

| 징후 | 원인 | 즉시 조치 |
|---|---|---|
| Bedrock 비용이 하루에 2배 이상 증가 | 봇/스크래퍼 유입 | `RATE_LIMIT_PER_DAY`를 30으로 낮추고 재배포 |
| Lambda `Throttles` 발생 | 예약 동시성 10에 도달 = 트래픽 급증 | 로그에서 IP 확인 → WAF에 IP 차단 규칙 추가 |
| "도구 반복 상한 도달" 로그 급증 | LLM이 검색을 계속 실패 → 반복 호출 | 프롬프트 점검, `MAX_TOOL_ITERATIONS`를 2로 |
| 평균 입력 토큰이 15,000 초과 | 히스토리 비대 | `historyTurns`를 6으로 |

## 5-4. 🚨 긴급 정지 (비용이 통제 불능일 때)

**가장 빠른 방법 — Lambda 예약 동시성을 0으로:**

Lambda → `bookbot-api` → 구성 → 동시성 → 편집 → **예약된 동시성 `0`** → 저장

즉시 모든 호출이 차단됩니다. 프론트는 계속 뜨지만 API가 429/에러를 반환합니다.
리소스를 지우지 않으므로 **나중에 값만 되돌리면 복구**됩니다.

**차선책 — CloudFront 배포 비활성화:**
CloudFront → 배포 → **비활성화** (Disable). 전파에 몇 분 걸립니다.

---

# 6. 2주 후 정리 (삭제) — 순서가 중요합니다

**의존 관계 때문에 순서를 지켜야 합니다.** 역순으로 지우면 "다른 리소스가 참조 중"이라며 실패합니다.

## 6-0. 지우기 전에 (선택)

포트폴리오로 남길 거라면 먼저 백업하세요:

- CloudFront 배포 도메인으로 접속해 **화면 녹화** (지우면 다시 못 봅니다)
- CloudWatch Logs Insights의 사용량 통계 스크린샷
- Cost Explorer의 실제 비용 스크린샷 (**"2주 운영에 $X 들었다"는 좋은 근거 자료**)
- 코드는 로컬에 있으니 그대로 Git에 커밋

## 6-1. 삭제 순서

### ① WAF Web ACL 연결 해제
1. WAF → **Global (CloudFront)** → Web ACLs → `bookbot-waf`
2. **Associated AWS resources** 탭 → 배포 선택 → **Disassociate**

> 연결을 먼저 끊어야 Web ACL을 지울 수 있습니다. 배포보다 먼저 처리하세요.

### ② CloudFront 배포 비활성화 → 삭제
1. CloudFront → 배포 선택 → **비활성화** (Disable)
2. 상태가 **비활성화됨(Disabled)** 이 될 때까지 **5~15분 대기** ← 건너뛸 수 없습니다
3. **삭제** (Delete)

### ③ WAF Web ACL 삭제
WAF → Web ACLs → `bookbot-waf` → **Delete**

### ④ S3 버킷 비우기 → 삭제
1. S3 → 버킷 선택 → **비우기** (Empty) → 확인란에 `영구 삭제` 입력
2. 버킷 선택 → **삭제** → 버킷 이름 입력

> 객체가 하나라도 남아 있으면 버킷 삭제가 실패합니다. 반드시 비우기 먼저.

### ⑤ Lambda 함수 삭제
Lambda → `bookbot-api` → **작업** → **삭제**
(함수 URL과 리소스 기반 정책도 함께 사라집니다)

### ⑥ DynamoDB 테이블 삭제
DynamoDB → 테이블 → `bookbot` → **삭제** → `삭제` 입력
(CloudWatch 알람 삭제 옵션이 나오면 함께 체크)

### ⑦ SSM 파라미터 삭제
Systems Manager → Parameter Store → 2개 선택 → **삭제**

> ⚠️ 여기에 실제 API 키가 들어 있습니다. **반드시 지우세요.**
> 그리고 Google Cloud Console과 Hardcover에서도 키를 폐기(revoke)하는 게 안전합니다.

### ⑧ IAM 역할 → 정책 삭제
1. IAM → 역할 → `bookbot-lambda-role` → **삭제**
2. IAM → 정책 → `bookbot-lambda-policy` → **삭제**

> 역할을 먼저 지워야 정책이 지워집니다 (정책이 역할에 연결돼 있으면 삭제 거부).

### ⑨ CloudWatch 로그 그룹 삭제
CloudWatch → 로그 그룹 → `/aws/lambda/bookbot-api` → **작업** → **로그 그룹 삭제**

> 로그 그룹은 Lambda를 지워도 **남아서 계속 스토리지 요금이 나갑니다.**
> 가장 많이 잊는 항목입니다.

### ⑩ CloudWatch 알람 삭제
CloudWatch → 모든 알람 → 4개 선택 → **작업** → **삭제**
(us-east-1의 요금 알람도 잊지 말고 — 리전 전환 필요)

### ⑪ SNS 주제 삭제
Amazon SNS → 주제 → `bookbot-alerts` → **삭제**
(us-east-1의 `bookbot-alerts-use1`도)

### ⑫ AWS Budgets 삭제
결제 및 비용 관리 → 예산 → 2개 삭제

> 💡 예산은 **맨 마지막에, 청구서를 확인한 뒤** 지우는 게 좋습니다.
> AWS 요금은 실시간이 아니라 **최대 24시간 지연**되어 반영됩니다.
> 리소스를 다 지운 다음날 Cost Explorer를 한 번 더 보고 정리하세요.

### ⑬ Bedrock 모델 액세스 (그냥 두면 됩니다)
모델 액세스는 **보유만으로는 요금이 발생하지 않습니다.**
호출한 만큼만 과금됩니다. 굳이 해제할 필요 없습니다.

## 6-2. 삭제 확인 체크리스트

```bash
# CLI가 있으면 한 번에 확인할 수 있습니다
REGION=ap-northeast-2

echo "== Lambda =="
aws lambda list-functions --region $REGION --query "Functions[?contains(FunctionName,'bookbot')].FunctionName"

echo "== DynamoDB =="
aws dynamodb list-tables --region $REGION --query "TableNames[?contains(@,'bookbot')]"

echo "== S3 =="
aws s3 ls | grep bookbot

echo "== CloudFront =="
aws cloudfront list-distributions --query "DistributionList.Items[].{Domain:DomainName,Status:Status}" 2>/dev/null

echo "== SSM 파라미터 =="
aws ssm describe-parameters --region $REGION --query "Parameters[?starts_with(Name,'/bookbot')].Name"

echo "== 로그 그룹 =="
aws logs describe-log-groups --region $REGION --log-group-name-prefix /aws/lambda/bookbot --query "logGroups[].logGroupName"

echo "== IAM =="
aws iam list-roles --query "Roles[?contains(RoleName,'bookbot')].RoleName"

echo "위 결과가 모두 비어 있으면 정리 완료"
```

| 항목 | 삭제 확인 |
|---|---|
| ☐ WAF Web ACL 연결 해제 + 삭제 | |
| ☐ CloudFront 배포 삭제 | |
| ☐ S3 버킷 비우기 + 삭제 | |
| ☐ Lambda 함수 삭제 | |
| ☐ DynamoDB 테이블 삭제 | |
| ☐ **SSM 파라미터 삭제 (API 키!)** | |
| ☐ **Google Cloud API 키 폐기** | |
| ☐ **Hardcover 토큰 폐기** | |
| ☐ IAM 역할 + 정책 삭제 | |
| ☐ **CloudWatch 로그 그룹 삭제** | |
| ☐ CloudWatch 알람 삭제 (서울 + us-east-1) | |
| ☐ SNS 주제 삭제 | |
| ☐ 다음날 Cost Explorer 재확인 → 예산 삭제 | |

---

# 7. 자주 하는 실수 (비용 관점)

| 실수 | 결과 | 예방 |
|---|---|---|
| Lambda 예약 동시성을 안 설정 | 트래픽 급증 시 Bedrock 호출 폭증 | STEP 6-G |
| 함수 URL 인증을 `NONE`으로 두고 방치 | 누구나 직접 호출 → 레이트리밋만으로 방어 | STEP 7에서 `AWS_IAM` |
| `MAX_TOOL_ITERATIONS`를 크게 설정 | 요청당 비용이 배수로 증가 | 4 이하 유지 |
| OpenSearch Serverless로 RAG 구축 | **최소 용량 때문에 월 $100+** | S3 Vectors 또는 pgvector 사용 |
| NAT Gateway를 써서 Lambda에 고정 IP | 시간당 $0.059 → 2주 $20 | 이 프로젝트는 VPC 불필요 |
| CloudWatch Logs를 `debug`로 방치 | 로그 수집 요금 증가 | 운영 시 `info` |
| CloudWatch 로그 그룹을 안 지움 | 프로젝트 종료 후에도 계속 과금 | 6-1 ⑨ |
| DynamoDB를 프로비저닝 모드로 생성 | 안 써도 요금 발생 | 온디맨드 (STEP 4-A 기본값) |
| S3 버전 관리 활성화 | 삭제한 객체도 계속 과금 | STEP 8에서 비활성화 |
