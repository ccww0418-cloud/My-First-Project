# 02. AWS 콘솔 단계별 설정 가이드

전부 **콘솔(웹 UI)** 기준입니다. AWS CLI는 콘솔로 하기 까다로운 2군데(STEP 10-C, STEP 6-B)에서만 대안으로 제시합니다.

## 이름 규칙 (미리 정해두면 헷갈리지 않습니다)

| 리소스 | 이름 | 비고 |
|---|---|---|
| 리전 | `ap-northeast-2` (서울) | CloudFront/WAF만 예외적으로 글로벌 |
| DynamoDB 테이블 | `bookbot` | |
| SSM 파라미터 경로 | `/bookbot/prod/` | |
| IAM 정책 | `bookbot-lambda-policy` | |
| IAM 역할 | `bookbot-lambda-role` | |
| Lambda 함수 | `bookbot-api` | |
| S3 버킷 | `bookbot-web-20260827` | **전 세계에서 유일**해야 함. 날짜/숫자를 붙이세요 |
| CloudFront OAC (S3) | `bookbot-s3-oac` | |
| CloudFront OAC (Lambda) | `bookbot-lambda-oac` | |
| WAF Web ACL | `bookbot-waf` | |

이 문서에서 `<계정ID>`, `<배포ID>` 같은 꺾쇠 표기는 본인 값으로 바꿔 넣으세요.

## 전체 순서

```
STEP 0  예산 알림 설정          ← 반드시 제일 먼저
STEP 1  리전 고정
STEP 2  Bedrock 모델 액세스 + 모델 ID 확보     ★ 가장 많이 막히는 곳
STEP 3  SSM Parameter Store에 API 키 저장
STEP 4  DynamoDB 테이블 + TTL
STEP 5  IAM 정책 + 실행 역할
STEP 6  Lambda 함수 생성 + 코드 업로드
STEP 7  Lambda Function URL (스트리밍)
STEP 8  S3 버킷 (프론트엔드)
STEP 9  CloudFront 배포 + S3 오리진(OAC)
STEP 10 CloudFront에 /api/* 동작 추가 + Lambda OAC   ★ 두 번째로 많이 막히는 곳
STEP 11 프론트엔드 빌드 & 업로드
STEP 12 WAF (권장)
STEP 13 모니터링 & 알람
STEP 14 (선택) Cognito 로그인
```

소요 시간: 처음이면 **3~4시간**. CloudFront 배포 전파에 5~15분 기다리는 구간이 있습니다.

---

# STEP 0. 예산 알림 — 반드시 제일 먼저

100만원을 확보했다고 해도, 잘못된 설정 하나로 며칠 만에 태울 수 있습니다.
리소스를 만들기 **전에** 알림부터 켭니다.

### 0-A. 결제 알림 활성화

1. 콘솔 우측 상단 계정 이름 → **결제 및 비용 관리** (Billing and Cost Management)
2. 좌측 메뉴 → **결제 기본 설정** (Billing preferences)
3. **알림 기본 설정** (Alert preferences) → **편집**
4. ☑ **AWS 무료 티어 사용량 알림 받기**
5. ☑ **CloudWatch 결제 지표 수신** (Receive CloudWatch billing alerts) ← 이걸 켜야 STEP 13의 요금 알람을 만들 수 있습니다
6. **업데이트** 저장

> ⚠️ CloudWatch 결제 지표는 **us-east-1(버지니아 북부)에만** 생성됩니다. 나중에 알람 만들 때 리전을 바꿔야 합니다.

### 0-B. 예산 생성

1. 좌측 메뉴 → **예산** (Budgets) → **예산 생성**
2. **템플릿 사용 (단순화)** 대신 **사용자 지정 (고급)** 선택
3. 예산 유형: **비용 예산 (Cost budget)**

| 항목 | 값 |
|---|---|
| 예산 이름 | `bookbot-monthly` |
| 기간 | 월별 (Monthly) |
| 예산 갱신 유형 | 반복 예산 |
| 시작 월 | 이번 달 |
| 예산 지정 방식 | 고정 (Fixed) |
| 예산 금액 | `100` USD (약 14만원 — 2주 실습에 넉넉한 상한) |

4. **다음** → **알림 임계값 추가**를 3번 눌러서 3개 만듭니다:

| # | 임계값 | 트리거 | 알림 대상 |
|---|---|---|---|
| 1 | 예산의 **50%** | 실제 비용 (Actual) | 본인 이메일 |
| 2 | 예산의 **80%** | 실제 비용 (Actual) | 본인 이메일 |
| 3 | 예산의 **100%** | **예측 비용 (Forecasted)** | 본인 이메일 |

> 3번(예측)이 가장 중요합니다. 실제 비용이 100%에 닿기 **전에** 추세를 보고 미리 알려줍니다.

### 0-C. Bedrock 전용 예산 하나 더 (강력 권장)

이 프로젝트에서 비용의 90%는 Bedrock입니다. 따로 감시하면 원인 파악이 빠릅니다.

1. **예산 생성** → 사용자 지정 → 비용 예산
2. 이름 `bookbot-bedrock-only`, 월별, 고정, 금액 `50` USD
3. **필터링 범위** → **필터 추가**
   - 차원: **서비스 (Service)**
   - 값: **Amazon Bedrock**
4. 알림 임계값: 실제 비용 **50%**, **90%**

### ✅ 체크포인트
**결제 및 비용 관리 → 예산**에 예산 2개가 보이고, 이메일로 SNS 구독 확인 메일이 왔으면 확인 클릭.

---

# STEP 1. 리전 고정

콘솔 우측 상단 리전 선택기 → **아시아 태평양(서울) ap-northeast-2**

앞으로 나오는 모든 화면에서 우측 상단이 **서울**인지 매번 확인하세요.
리전이 다르면 "만들었는데 안 보인다"는 상황이 생기는데, 실습에서 시간을 가장 많이 잡아먹는 실수입니다.

**예외 — 글로벌 서비스라 리전 선택기가 무의미한 것들:**
- CloudFront (STEP 9, 10)
- WAF for CloudFront (STEP 12) → 콘솔에서 **Global (CloudFront)** 를 명시적으로 골라야 함
- IAM (STEP 5)
- 결제/예산 (STEP 0)

---

# STEP 2. Bedrock 모델 액세스 + 모델 ID 확보 ★

실습에서 **가장 많이 막히는 단계**입니다. 두 가지를 해야 합니다:
① 모델 사용 승인 받기 ② 이 리전에서 유효한 **정확한 모델 ID** 알아내기

## 2-A. 모델 액세스 요청

1. 콘솔 검색창에 `Bedrock` → **Amazon Bedrock**
2. 리전이 **서울**인지 확인
3. 좌측 메뉴 맨 아래 **Bedrock 구성** (Bedrock configurations) → **모델 액세스** (Model access)
4. 우측 상단 **모델 액세스 수정** (Modify model access) 버튼
5. 목록에서 **Anthropic** 항목을 펼치고 사용할 모델을 체크
   - `Claude Sonnet` 계열 → 품질/속도 균형. **이 프로젝트 권장**
   - `Claude Haiku` 계열 → 가장 저렴하고 빠름. 비용을 더 줄이려면 이것
   - 둘 다 체크해두면 나중에 환경 변수만 바꿔 전환할 수 있습니다
6. **다음**
7. **Anthropic 모델은 사용 사례 양식이 뜹니다.** 아래처럼 채우세요:

| 항목 | 입력 예시 |
|---|---|
| 회사 이름 (Company name) | 개인이면 본인 이름 또는 `Personal Project` |
| 회사 웹사이트 URL | 없으면 GitHub 프로필 URL 또는 개인 블로그 |
| 업종 (Industry) | `Education` 또는 `Technology` |
| 사용 사례 (Intended use case) | `Educational project. A book recommendation chatbot that uses public book APIs (Google Books, Open Library, Project Gutenberg, Hardcover) and Claude to explain why each book fits the user's request. Internal demo, expected under 2,000 requests total over 2 weeks.` |

8. **제출** (Submit)
9. 상태가 **액세스 부여됨** (Access granted)으로 바뀔 때까지 대기
   - Claude 계열은 보통 **즉시~수 분**입니다
   - **진행 중(In progress)** 이면 페이지를 새로고침하며 기다립니다
   - 10분 넘게 안 바뀌면 리전을 확인하세요 (다른 리전에서 요청했을 수 있음)

## 2-B. 이 리전에서 쓸 정확한 모델 ID 찾기 ★★

**여기가 핵심입니다.** 서울 리전은 `us.anthropic...` 형태의 ID가 **동작하지 않습니다.**
블로그나 예제에 나오는 ID를 그대로 복붙하면 `ValidationException`이 납니다.

1. Bedrock 좌측 메뉴 → **모델 카탈로그** (Model catalog)
2. 승인받은 모델(예: Claude Sonnet)을 클릭
3. 모델 상세 페이지에서 두 섹션을 확인:
   - **리전별 가용성** (Regional availability) 표 → `ap-northeast-2` 행에 In-Region / Geo / Global 중 무엇이 지원되는지
   - **추론 프로필 ID** (Inference profile IDs) 섹션 → **여기 적힌 문자열을 그대로 복사**

접두사가 의미하는 것:

| 접두사 | 처리 위치 | 특징 |
|---|---|---|
| (접두사 없음) | 호출한 리전 안에서만 (In-Region) | **온디맨드 쿼터가 가장 낮아 데모 중 스로틀링 위험** |
| `us.` | 미국 리전들 (Geo) | us-east-1에서 호출할 때 권장 |
| `apac.` | APAC 리전들 (Geo) | 서울에서 호출할 때 권장 |
| `eu.` / `au.` / `jp.` | 각 지역 | 데이터 소재지 요건이 있을 때 |
| `global.` | 전 세계 상용 리전 | 처리량 가장 높음, 약 10% 저렴 |

리전과 접두사의 지역이 맞지 않으면 `ValidationException`이 납니다.
(us-east-1에서 `apac.*`, 서울에서 `us.*` → 실패)

### ⚠️ ID 형식이 두 세대로 나뉩니다

| 세대 | 형식 | 예시 |
|---|---|---|
| **레거시** (Claude Opus 4.6 이전) | 날짜 + 버전 접미사 **필수** | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| **신형** (Claude Sonnet 4.6 이후) | 날짜·접미사 **없음** | `us.anthropic.claude-sonnet-4-6` |

Anthropic이 Sonnet 4.6부터 접미사를 없앴습니다.
따라서 `anthropic.claude-sonnet-4-6` 처럼 짧은 ID를 보고 "잘려 있다"고 판단하면 안 됩니다.
**모델 카드의 Programmatic Access 표에 적힌 값을 그대로 쓰세요.**

반대로 `anthropic.claude-sonnet-4-5-20250929` 처럼 **날짜는 있는데 `-v1:0`이 없으면**
잘린 값이라 호출이 실패합니다.

> 💡 CLI가 설치되어 있으면 한 번에 확인할 수 있습니다:
> ```bash
> cd backend && bash scripts/list-models.sh
> ```

📋 **복사한 ID를 메모장에 적어두세요.** STEP 6에서 환경 변수로 넣습니다.

## 2-C. Playground에서 먼저 테스트

Lambda를 만들기 전에 모델이 실제로 응답하는지 확인합니다. 여기서 실패하면 뒤 단계가 전부 무의미합니다.

1. Bedrock 좌측 메뉴 → **플레이그라운드** (Playgrounds) → **채팅 / 텍스트** (Chat/Text)
2. **모델 선택** → 카테고리 Anthropic → 승인받은 모델 → **적용**
3. 입력창에 `한국 소설 한 권만 추천해줘` 입력 → 실행
4. 응답이 나오면 성공

### ✅ 체크포인트
- 모델 액세스 상태 = **액세스 부여됨**
- 추론 프로필 ID를 메모했다
- Playground에서 응답을 받았다

### 자주 막히는 지점

| 증상 | 원인과 해결 |
|---|---|
| 모델 목록에 Anthropic이 안 보임 | 리전이 서울이 아님. 또는 해당 리전에서 미제공 |
| `AccessDeniedException` | 모델 액세스가 아직 승인 안 됨, 또는 다른 리전에서 승인받음 |
| `ValidationException` | 모델 ID가 이 리전에서 무효. `us.` 접두사를 쓰고 있을 가능성 99% |
| 사용 사례 양식이 반복 반려됨 | 용도를 구체적으로. "테스트"보다 위 예시처럼 서비스 내용을 서술 |

---

# STEP 3. SSM Parameter Store에 외부 API 키 저장

API 키를 Lambda 환경 변수에 넣지 않는 이유: 환경 변수는 콘솔에서 평문으로 보이고,
`GetFunctionConfiguration` 권한만 있으면 누구나 읽을 수 있습니다.

> 🔑 아직 키가 없으면 [03-external-apis.md](./03-external-apis.md)에서 먼저 발급받고 오세요.
> Google Books 키와 Hardcover 토큰 2개가 필요합니다. (Open Library와 Gutendex는 키 불필요)

### 3-A. Google Books API 키 저장

1. 콘솔 검색창 → `Systems Manager` → **AWS Systems Manager**
2. 좌측 메뉴 → **애플리케이션 관리** (Application Management) → **Parameter Store**
3. **파라미터 생성** (Create parameter)

| 항목 | 값 |
|---|---|
| 이름 (Name) | `/bookbot/prod/GOOGLE_BOOKS_API_KEY` |
| 설명 | `Google Books API key for BookBot` |
| 계층 (Tier) | **표준** (Standard) ← 무료 |
| 유형 (Type) | **SecureString** |
| KMS 키 소스 | **내 현재 계정** (My current account) |
| KMS 키 ID | `alias/aws/ssm` ← 기본값. 무료 |
| 값 (Value) | 발급받은 키 (`AIza...`) |

4. **파라미터 생성**

> ⚠️ 이름 앞의 슬래시(`/`)를 빼먹지 마세요. 코드가 `/bookbot/prod` 경로를 재귀 조회합니다.

### 3-B. Hardcover 토큰 저장

같은 방식으로 하나 더:

| 항목 | 값 |
|---|---|
| 이름 | `/bookbot/prod/HARDCOVER_TOKEN` |
| 계층 | 표준 |
| 유형 | **SecureString** |
| KMS 키 ID | `alias/aws/ssm` |
| 값 | Hardcover에서 받은 토큰 |

> Hardcover 토큰은 `Bearer eyJ...` 처럼 `Bearer ` 접두사가 붙어 있을 수 있습니다.
> **그대로 붙여넣어도 됩니다** — 코드에서 정규화합니다 (`hardcover.mjs`의 `normalizeToken`).

그리고 국내 도서용으로 하나 더 (한국어 추천 품질에 직결됩니다):

| 항목 | 값 |
|---|---|
| 이름 | `/bookbot/prod/ALADIN_TTB_KEY` |
| 계층 | 표준 |
| 유형 | **SecureString** |
| KMS 키 ID | `alias/aws/ssm` |
| 값 | 알라딘 TTB 키 (`ttb...`) |

> 발급 절차는 [03-external-apis.md 8-A](./03-external-apis.md#8-a-ttb-키-받기).
> 이 키가 없어도 서비스는 정상 동작하고 **한국어 결과만 빈약해집니다.**
> IAM 정책이 `parameter/bookbot/prod/*` 와일드카드라 **권한 수정은 필요 없습니다.**

### ✅ 체크포인트
Parameter Store 목록에 파라미터 3개가 보이고, 유형이 전부 `SecureString`.
파라미터를 클릭해서 **값 표시** (Show decrypted value)를 눌렀을 때 원래 키가 나오면 정상.

---

# STEP 4. DynamoDB 테이블 + TTL

테이블 하나로 세션·캐시·레이트리밋 3가지를 다 담습니다 (단일 테이블 설계).

### 4-A. 테이블 생성

1. 콘솔 검색창 → `DynamoDB`
2. 좌측 메뉴 → **테이블** → **테이블 생성**

| 항목 | 값 |
|---|---|
| 테이블 이름 | `bookbot` |
| 파티션 키 (Partition key) | `pk` / 유형 **문자열** (String) |
| 정렬 키 (Sort key) | `sk` / 유형 **문자열** (String) |
| 테이블 설정 | **기본 설정** (Default settings) |

3. **테이블 생성** 클릭 → 상태가 **활성** (Active)이 될 때까지 10~30초 대기

> 용량 모드는 기본값인 **온디맨드**(On-demand)로 둡니다.
> 요청량이 예측 불가능한 데모에 적합하고, 안 쓰면 요금이 0입니다.
> (프로비저닝 모드는 미리 용량을 사두는 방식이라 안 써도 돈이 나갑니다.)

### 4-B. TTL 활성화 ★ 빠뜨리기 쉬움

TTL을 켜야 세션·캐시·레이트리밋 데이터가 자동으로 삭제됩니다.
안 켜면 데이터가 계속 쌓이고, 2주 후 정리할 때 수동으로 지워야 합니다.

1. 방금 만든 `bookbot` 테이블 클릭
2. **추가 설정** (Additional settings) 탭
3. 아래로 스크롤 → **Time to Live (TTL)** 섹션 → **켜기** (Turn on)

| 항목 | 값 |
|---|---|
| TTL 속성 이름 | `ttl` ← **소문자. 정확히 이 이름이어야 합니다** |
| 만료 시뮬레이션 | 건너뛰기 |

4. **TTL 켜기** 저장

> DynamoDB TTL은 만료 시각으로 **epoch seconds(초 단위 정수)** 를 기대합니다.
> 밀리초를 넣으면 5만 년 뒤가 되어 절대 안 지워집니다.
> 코드의 `lib/ddb.mjs`의 `ttlFromNow()`가 초 단위로 계산합니다.
>
> 또한 TTL 삭제는 **실시간이 아닙니다.** 만료 후 최대 48시간 안에 삭제됩니다.
> 그래서 레이트리밋 코드는 TTL에 의존하지 않고 시간 윈도우를 키에 넣습니다.

### ✅ 체크포인트
테이블 상태 **활성**, 추가 설정 탭에서 TTL이 **켜짐 / 속성 `ttl`** 로 표시.

---

# STEP 5. IAM 정책 + Lambda 실행 역할

Lambda가 Bedrock·DynamoDB·SSM에 접근할 권한을 만듭니다.
`AdministratorAccess` 같은 걸 붙이면 안 됩니다 — 최소 권한 원칙 실습이기도 합니다.

### 5-A. 계정 ID 확인

콘솔 우측 상단 계정 이름 클릭 → **계정 ID** 12자리 숫자 복사. 다음 JSON에 넣습니다.

### 5-B. 정책 생성

1. 콘솔 검색창 → `IAM` → 좌측 메뉴 **정책** (Policies) → **정책 생성**
2. **JSON** 탭 선택 → 편집창의 내용을 모두 지우고 아래를 붙여넣기
3. `<계정ID>` 를 본인 12자리 숫자로 **3군데** 모두 교체

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:<계정ID>:inference-profile/*",
        "arn:aws:bedrock:*:<계정ID>:application-inference-profile/*"
      ]
    },
    {
      "Sid": "DynamoDBSingleTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:*:<계정ID>:table/bookbot"
    },
    {
      "Sid": "ReadApiKeysFromSSM",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath"
      ],
      "Resource": [
        "arn:aws:ssm:*:<계정ID>:parameter/bookbot/prod",
        "arn:aws:ssm:*:<계정ID>:parameter/bookbot/prod/*"
      ]
    },
    {
      "Sid": "DecryptSecureString",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": {
        "StringLike": {
          "kms:ViaService": "ssm.*.amazonaws.com"
        }
      }
    }
  ]
}
```

4. **다음** → 정책 이름 `bookbot-lambda-policy` → **정책 생성**

**이 정책을 이렇게 쓴 이유:**

| 문 (Sid) | 설명 |
|---|---|
| `BedrockInvoke` | 리전을 `*`로 둔 이유: 교차 리전 추론 프로필(`apac.`/`global.`)은 요청이 다른 리전으로 라우팅됩니다. 리전을 고정하면 실패합니다 |
| `DynamoDBSingleTable` | 테이블 하나만. `Scan`과 `DeleteItem`은 코드가 안 쓰므로 제외 |
| `ReadApiKeysFromSSM` | `/bookbot/prod` 경로만. **ARN이 2개인 이유**: `GetParametersByPath`는 자식 파라미터가 아니라 **경로 자체**(`parameter/bookbot/prod`)에 대해 권한을 검사합니다. `/*` 하나만 넣으면 `AccessDeniedException`이 납니다. SSM IAM의 대표적인 함정입니다 |
| `DecryptSecureString` | SecureString 복호화용. `kms:ViaService` 조건으로 **SSM을 경유한 호출만** 허용 |

> **왜 리전을 `*`로 두었나 (중요)**
> 원래는 `ap-northeast-2`를 하드코딩했는데, 실제 실습에서 이게 큰 함정이 됩니다.
> Lambda를 실수로 다른 리전(예: us-east-1)에 만들면 정책이 조용히 거부해서
> "왜 API 키를 못 읽지?"로 몇 시간을 헤매게 됩니다.
>
> 리전을 `*`로 둬도 **계정 ID와 리소스 이름(`table/bookbot`, `parameter/bookbot/prod/*`)으로
> 여전히 좁혀져 있습니다.** 내 계정의 그 이름을 가진 리소스만 접근 가능합니다.
> 실습에서는 이 편이 훨씬 안전합니다(디버깅 시간 = 예산 낭비).
>
> 운영 환경이라면 리전을 명시해서 더 조이는 게 맞습니다.

### 5-C. 실행 역할 생성

1. IAM 좌측 메뉴 → **역할** (Roles) → **역할 생성**
2. 신뢰할 수 있는 엔터티 유형: **AWS 서비스**
3. 사용 사례: **Lambda** → **다음**
4. 권한 정책 검색창에서 아래 2개를 찾아 체크:
   - `bookbot-lambda-policy` (방금 만든 것)
   - `AWSLambdaBasicExecutionRole` (CloudWatch Logs 쓰기용 — **이거 없으면 로그가 안 남아서 디버깅이 불가능합니다**)
5. **다음** → 역할 이름 `bookbot-lambda-role` → **역할 생성**

### ✅ 체크포인트
IAM → 역할 → `bookbot-lambda-role` → **권한** 탭에 정책 2개가 붙어 있음.
**신뢰 관계** 탭의 Principal이 `lambda.amazonaws.com`.

---

# STEP 6. Lambda 함수 생성 + 코드 업로드

## 6-A. 배포용 zip 만들기 (로컬 터미널)

```bash
cd /Users/phontom/Desktop/0827/backend
npm install
bash scripts/build.sh
```

→ `backend/dist/bookbot-backend.zip` 생성 (약 10~15MB)

> Node.js가 없으면 먼저 설치하세요: `brew install node@22`
> Homebrew의 node@22는 PATH에 자동 등록되지 않습니다:
> ```bash
> export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
> ```

**배포 전에 로컬에서 외부 API 연결을 먼저 확인하는 걸 강력히 권합니다.**
AWS에 올린 뒤 디버깅하는 것보다 훨씬 빠릅니다:
```bash
export GOOGLE_BOOKS_API_KEY=AIza...
export HARDCOVER_TOKEN=eyJ...
export ALADIN_TTB_KEY=ttb...
npm run smoke
```

## 6-B. 함수 생성

1. 콘솔 검색창 → `Lambda` → **함수 생성**
2. **새로 작성** (Author from scratch) 선택

| 항목 | 값 |
|---|---|
| 함수 이름 | `bookbot-api` |
| 런타임 (Runtime) | **Node.js 22.x** |
| 아키텍처 (Architecture) | **arm64** ← x86_64보다 약 20% 저렴 |

3. **권한** 섹션을 펼치기 → **기본 실행 역할 변경** (Change default execution role)
   - **기존 역할 사용** (Use an existing role) 선택
   - 기존 역할: `bookbot-lambda-role`
4. **함수 생성**

## 6-C. 코드 업로드

1. 생성된 함수 페이지 → **코드** (Code) 탭
2. 우측 **업로드 원본** (Upload from) → **.zip 파일**
3. **업로드** → `backend/dist/bookbot-backend.zip` 선택 → **저장**

> zip이 50MB를 넘으면 콘솔 직접 업로드가 안 됩니다. 그럴 때는:
> S3 버킷에 zip을 올리고 **업로드 원본 → Amazon S3 위치**를 선택해 S3 URI를 입력하세요.

## 6-D. 핸들러 변경 ★ 빠뜨리면 무조건 실패

기본값은 `index.handler`인데, 우리 코드는 `src/index.mjs`에 있으므로 경로가 다릅니다.

1. **코드** 탭 아래로 스크롤 → **런타임 설정** (Runtime settings) → **편집**
2. 핸들러 (Handler): **`src/index.handler`**
3. **저장**

> `src/index.handler`의 의미: `src/index.mjs` 파일의 `handler` export.
> API Gateway를 쓰는 구성으로 바꾸려면 `src/index.bufferedHandler`로 변경하세요.

## 6-E. 일반 구성

1. **구성** (Configuration) 탭 → **일반 구성** (General configuration) → **편집**

| 항목 | 값 | 이유 |
|---|---|---|
| 메모리 (Memory) | **1024 MB** | Lambda는 메모리에 비례해 CPU도 늘어납니다. 512MB면 JSON 파싱과 SDK 초기화가 느려져 오히려 총비용이 비슷하거나 더 듭니다 |
| 임시 스토리지 | 512 MB (기본) | 디스크를 안 씀 |
| 제한 시간 (Timeout) | **1분 30초** | 도구 4회 반복 + LLM 스트리밍을 고려한 여유. 기본값 3초로는 100% 타임아웃 |

2. **저장**

## 6-F. 환경 변수

1. **구성** 탭 → **환경 변수** (Environment variables) → **편집**
2. **환경 변수 추가**를 눌러 아래를 하나씩 넣습니다:

| 키 | 값 | 비고 |
|---|---|---|
| `BEDROCK_REGION` | `ap-northeast-2` | |
| `BEDROCK_MODEL_ID` | **STEP 2-B에서 복사한 값** | 예: `apac.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `BEDROCK_MAX_TOKENS` | `2048` | |
| `BEDROCK_TEMPERATURE` | `0.4` | 낮을수록 일관됨. 추천 서비스에 적합 |
| `TABLE_NAME` | `bookbot` | |
| `SSM_PREFIX` | `/bookbot/prod` | |
| `RATE_LIMIT_PER_MINUTE` | `10` | |
| `RATE_LIMIT_PER_DAY` | `150` | |
| `MAX_TOOL_ITERATIONS` | `4` | **비용 안전장치. 올리지 마세요** |
| `EXTERNAL_API_TIMEOUT_MS` | `6000` | |
| `GUTENDEX_TIMEOUT_MS` | `4000` | gutendex.com이 느릴 때 대비 |
| `CONTACT_EMAIL` | 본인 이메일 | Open Library가 User-Agent에 연락처를 요구합니다 |
| `LOG_LEVEL` | `info` | 문제 생기면 `debug`로 |

3. **저장**

> ⚠️ `AWS_REGION`은 넣지 마세요. Lambda가 예약해둔 변수라 저장이 거부됩니다.

## 6-G. 예약된 동시성 — 비용 폭탄 방지 ★

3차 방어선입니다. 동시 실행 수를 물리적으로 제한합니다.

1. **구성** 탭 → **동시성 및 재귀 감지** (Concurrency and recursion detection)
2. **동시성** 섹션 → **편집**
3. **예약된 동시성** (Reserve concurrency) 선택 → 값 **`10`**
4. **저장**

이렇게 하면 누가 초당 1000번을 호출해도 동시에 10개만 실행됩니다.
Bedrock 호출도 그만큼만 발생합니다.

### ✅ 체크포인트 — 콘솔에서 테스트 실행

1. **테스트** (Test) 탭 → 이벤트 이름 `health`
2. 이벤트 JSON을 아래로 교체:

```json
{
  "version": "2.0",
  "rawPath": "/api/health",
  "requestContext": {
    "http": { "method": "GET", "sourceIp": "127.0.0.1" }
  },
  "headers": {},
  "isBase64Encoded": false
}
```

3. **저장** → **테스트**

### 응답 읽는 법

먼저 알아둘 것: 스트리밍 핸들러를 콘솔에서 테스트하면 응답이 **두 덩어리로 붙어서** 나옵니다.

```
{"statusCode":200,"headers":{...}}{"ok":true,"time":"...","regions":{...}}
 └── 스트리밍 메타데이터 프리앰블 ──┘└────── 실제 응답 본문 ──────┘
```

앞의 `{"statusCode":200,...}`는 Lambda 응답 스트리밍이 붙이는 헤더 정보입니다.
**이렇게 나오는 게 정상**이고, 함수가 제대로 실행됐다는 뜻입니다.
(CloudFront를 통해 브라우저로 호출하면 뒤쪽 본문만 보입니다.)

### 정상 응답

```json
{
  "ok": true,
  "regions": {
    "lambda": "ap-northeast-2",
    "dynamodb": "ap-northeast-2",
    "ssm": "ap-northeast-2",
    "bedrock": "ap-northeast-2"
  },
  "bedrock": {
    "modelId": "apac.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "modelIdLooksValid": true
  },
  "dynamodb": { "ok": true, "table": "bookbot", "latencyMs": 23 },
  "secrets": { "GOOGLE_BOOKS_API_KEY": true, "HARDCOVER_TOKEN": true, "ALADIN_TTB_KEY": true },
  "problems": []
}
```

**`problems` 배열만 보면 됩니다. 비어 있으면 설정 완료입니다.**

문제가 있으면 원인과 해결 방법이 문장으로 담겨 나옵니다. 예:

```json
{
  "ok": false,
  "problems": [
    "DynamoDB 접근 실패 (ResourceNotFoundException): 테이블 \"bookbot\"이 리전 us-east-1에 없습니다. 다른 리전에 만들었거나 이름이 다릅니다.",
    "SSM 경로 /bookbot/prod 에 파라미터가 0개입니다. 리전 us-east-1의 Parameter Store를 확인하세요 (다른 리전에 만들면 보이지 않습니다).",
    "BEDROCK_MODEL_ID \"anthropic.claude-sonnet-4-6\"에 버전 접미사(예: -20250929-v1:0)가 없습니다. ..."
  ]
}
```

### 🚨 가장 흔한 함정 — 리전 불일치

`regions.lambda`가 의도한 리전이 **아니면** 여기서 멈추고 해결하세요.

DynamoDB와 SSM 클라이언트는 **Lambda와 같은 리전**을 자동으로 사용합니다
(`AWS_REGION` 환경 변수). Lambda가 us-east-1에 있으면 서울에 만든 테이블과
파라미터는 **존재하지 않는 것처럼 보입니다.**

**해결 방법 두 가지 — 하나를 고르세요:**

**방법 A — Lambda를 원래 의도한 리전(서울)에 다시 만들기**
1. 잘못된 리전의 Lambda 함수 삭제
2. 우측 상단 리전을 **서울**로 변경
3. STEP 6을 다시 수행 (zip은 이미 있으니 5분이면 됩니다)

**방법 B — 나머지를 Lambda가 있는 리전으로 옮기기**
`regions.lambda`에 표시된 리전으로 전환한 뒤:
1. DynamoDB 테이블 `bookbot` 생성 + TTL (STEP 4)
2. SSM 파라미터 2개 생성 (STEP 3)
3. Bedrock 모델 액세스 요청 (STEP 2) ← **리전별로 따로 승인받아야 합니다**
4. `BEDROCK_REGION` 환경 변수를 그 리전으로 변경

> us-east-1(버지니아)은 Bedrock 모델 종류가 가장 많다는 장점이 있습니다.
> 한국 사용자 대상이라면 지연 시간이 200ms 정도 늘어나지만 체감 차이는 크지 않습니다.
> **이미 us-east-1에 만들었다면 방법 B로 그대로 진행하는 것도 합리적인 선택입니다.**
> 중요한 건 **Lambda / DynamoDB / SSM 세 개가 같은 리전에 있는 것**입니다.
> (Bedrock만 다른 리전이어도 괜찮습니다 — `BEDROCK_REGION`으로 분리했습니다)

### 🚨 두 번째 함정 — 모델 ID

헬스체크의 `bedrock` 블록을 보세요:

```json
"bedrock": {
  "modelId": "anthropic.claude-sonnet-4-6",
  "inferenceScope": "(없음 — In-Region)",
  "idFormat": "modern(4.6+, 접미사 없음)",
  "modelIdLooksValid": true,
  "note": "In-Region 추론입니다. 온디맨드 쿼터가 가장 낮아..."
}
```

**형식 판정 기준** (두 세대가 공존하므로 접미사 유무만으로 판단하면 안 됩니다):

```
✓ anthropic.claude-sonnet-4-6                      신형. In-Region. 유효
✓ us.anthropic.claude-sonnet-4-6                   신형 + Geo(US). us-east-1 권장
✓ global.anthropic.claude-sonnet-4-6               신형 + Global. 처리량 최고
✓ us.anthropic.claude-sonnet-4-5-20250929-v1:0     레거시. 유효
✗ anthropic.claude-sonnet-4-5-20250929             레거시인데 -v1:0 잘림 → 실패
✗ us.anthropic.claude-sonnet-4-6  (서울에서 호출)   접두사/리전 불일치 → 실패
```

정확한 값은 Bedrock 콘솔 → **모델 카탈로그** → 모델 클릭 →
**Programmatic Access** 표의 `Model ID` / `Geo inference ID` / `Global inference ID`에서 복사하세요.

CLI로 확인:
```bash
aws bedrock list-inference-profiles --region us-east-1 --type-equals SYSTEM_DEFINED \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'anthropic')].inferenceProfileId" \
  --output table
```

> 💡 **접두사 없는 In-Region ID로 시작했다면 `us.` 를 붙이는 걸 권합니다.**
> In-Region은 온디맨드 쿼터가 가장 낮아서 데모 중 `ThrottlingException`이 날 수 있습니다.
> 코드 수정 없이 환경 변수만 바꾸면 됩니다.

이어서 채팅도 테스트해봅니다. 새 테스트 이벤트 `chat`:

```json
{
  "version": "2.0",
  "rawPath": "/api/chat",
  "requestContext": {
    "http": { "method": "POST", "sourceIp": "127.0.0.1" }
  },
  "headers": { "content-type": "application/json" },
  "body": "{\"message\":\"무료로 읽을 수 있는 고전 소설 추천해줘\"}",
  "isBase64Encoded": false
}
```

> 스트리밍 핸들러를 콘솔 테스트로 호출하면 응답 표시가 깔끔하지 않을 수 있습니다.
> **모니터링 → CloudWatch 로그 보기**에서 `chat 완료` 로그와 토큰 사용량이 찍혔는지 확인하세요.
> 여기서 Bedrock 오류가 나면 로그에 **원인별 해결 힌트**가 한국어로 찍히도록 만들어 뒀습니다 (`agent.mjs`).

### 자주 막히는 지점

| 로그의 에러 | 해결 |
|---|---|
| `Cannot find module 'src/index'` | 핸들러가 `src/index.handler`인지 확인 (STEP 6-D) |
| `Cannot find package '@aws-sdk/client-bedrock-runtime'` | zip에 node_modules가 안 들어감. `bash scripts/build.sh`로 다시 빌드 |
| `AccessDeniedException` (Bedrock) | STEP 2 모델 액세스 또는 STEP 5 정책 |
| `ValidationException` (Bedrock) | `BEDROCK_MODEL_ID`가 이 리전에서 무효 (STEP 2-B) |
| `ResourceNotFoundException` (DynamoDB) | 테이블 이름 오타 또는 리전 불일치 |
| `Task timed out after 3.00 seconds` | STEP 6-E 타임아웃 설정 안 됨 |
| `ParameterNotFound` | SSM 파라미터 이름의 앞 슬래시 확인 |

---

# STEP 7. Lambda Function URL (스트리밍)

1. `bookbot-api` → **구성** 탭 → **함수 URL** (Function URL) → **함수 URL 생성**

| 항목 | 값 | 이유 |
|---|---|---|
| 인증 유형 (Auth type) | **AWS_IAM** | **NONE으로 두면 URL을 아는 누구나 직접 호출 가능 = 비용 폭탄.** CloudFront OAC를 쓰려면 AWS_IAM이 필수입니다 |
| 호출 모드 (Invoke mode) | **RESPONSE_STREAM** | 스트리밍의 핵심. `추가 설정`을 펼쳐야 보일 수 있습니다 |
| CORS 구성 | **끄기** (체크 해제) | CloudFront 단일 오리진이라 same-origin. Lambda의 CORS 설정과 앱 코드의 CORS 헤더가 충돌할 수 있어 끕니다 |

2. **저장**
3. 생성된 **함수 URL**을 복사해 메모 (예: `https://abcd1234....lambda-url.ap-northeast-2.on.aws/`)

> ⚠️ 이 URL을 브라우저에 그대로 붙여넣으면 **403 Forbidden**이 정상입니다.
> AWS_IAM 인증이라 SigV4 서명 없이는 못 부릅니다. STEP 10에서 CloudFront가 서명해줍니다.

### ✅ 체크포인트
함수 URL이 생성되고, 호출 모드가 **RESPONSE_STREAM**, 인증 유형이 **AWS_IAM**.

---

# STEP 8. S3 버킷 (프론트엔드 정적 호스팅)

**S3 정적 웹사이트 호스팅 기능은 켜지 않습니다.** CloudFront + OAC로만 접근하게 만듭니다.
(정적 웹사이트 호스팅은 버킷을 퍼블릭으로 열어야 하고, HTTPS도 안 됩니다.)

1. 콘솔 검색창 → `S3` → **버킷 만들기**

| 항목 | 값 |
|---|---|
| 버킷 유형 | 범용 (General purpose) |
| 버킷 이름 | `bookbot-web-20260827` ← **전 세계에서 유일**해야 함 |
| AWS 리전 | 아시아 태평양(서울) ap-northeast-2 |
| 객체 소유권 | **ACL 비활성화됨 (권장)** ← OAC 사용 시 필수 |
| 이 버킷의 퍼블릭 액세스 차단 설정 | ☑ **모든 퍼블릭 액세스 차단** (4개 전부 체크 유지) |
| 버킷 버전 관리 | **비활성화** (실습에선 불필요, 스토리지 요금만 늘어남) |
| 기본 암호화 | SSE-S3 (기본값) |

2. **버킷 만들기**

> "퍼블릭 액세스를 다 막는데 어떻게 웹사이트가 되지?"
> → CloudFront가 OAC로 SigV4 서명해서 S3에 접근합니다. 사용자는 CloudFront만 봅니다.
> 이게 S3 정적 호스팅의 현재 표준 방식입니다.

### ✅ 체크포인트
버킷이 목록에 보이고, **권한** 탭에서 "퍼블릭 액세스 차단: 켜기".

---

# STEP 9. CloudFront 배포 + S3 오리진 (OAC)

> CloudFront 콘솔 UI는 개편이 잦습니다. 아래는 **설정해야 하는 값** 위주로 적었습니다.
> 화면 배치가 다르면 같은 이름의 필드를 찾아 설정하세요.

1. 콘솔 검색창 → `CloudFront` → **배포 생성** (Create distribution)

### 9-A. 오리진 (Origin)

| 항목 | 값 |
|---|---|
| 오리진 도메인 (Origin domain) | 드롭다운에서 `bookbot-web-20260827.s3.ap-northeast-2.amazonaws.com` 선택 |
| 오리진 경로 | 비움 |
| 이름 | 자동 생성값 그대로 |
| 오리진 액세스 (Origin access) | **Origin access control settings (권장)** |
| → 오리진 액세스 컨트롤 | **새 OAC 생성** → 이름 `bookbot-s3-oac`, 서명 동작 **요청 서명(권장)** → 생성 |

> 드롭다운에 S3 버킷이 "웹사이트 엔드포인트" 형태(`s3-website-...`)로도 나올 수 있습니다.
> **`s3.ap-northeast-2.amazonaws.com` 형태(REST 엔드포인트)를 골라야** OAC가 동작합니다.

### 9-B. 기본 캐시 동작 (Default cache behavior)

| 항목 | 값 |
|---|---|
| 뷰어 프로토콜 정책 | **Redirect HTTP to HTTPS** |
| 허용된 HTTP 메서드 | `GET, HEAD` |
| 뷰어 액세스 제한 | 아니요 |
| 캐시 정책 | **CachingOptimized** (관리형) |
| 원본 요청 정책 | 없음 |
| 응답 헤더 정책 | **SecurityHeadersPolicy** (관리형) ← HSTS 등 보안 헤더 자동 추가 |
| 압축 자동 개설 | 예 (Yes) |

### 9-C. 설정 (Settings)

| 항목 | 값 |
|---|---|
| 가격 분류 | **북미, 유럽, 아시아, 중동 및 아프리카 사용** (PriceClass_200) ← 한국 사용자 대상이면 충분하고 저렴 |
| WAF | **보안 보호 비활성화** ← STEP 12에서 따로 붙입니다 (지금 켜면 기본 규칙이 붙어 요금 예측이 어려움) |
| 대체 도메인 이름 (CNAME) | 비움 (기본 `*.cloudfront.net` 사용) |
| 기본값 루트 객체 (Default root object) | **`index.html`** ← ★ 빠뜨리면 루트 접속 시 AccessDenied |

2. **배포 생성** 클릭

### 9-D. S3 버킷 정책 적용 ★ 이 단계를 놓치면 403

배포 생성 직후 **"S3 버킷 정책을 업데이트해야 합니다"** 안내 배너가 뜹니다.

1. 배너의 **정책 복사** (Copy policy) 클릭
2. **S3 버킷 권한으로 이동** 링크 클릭 (또는 S3 콘솔 → 버킷 → **권한** 탭 → **버킷 정책** → **편집**)
3. 복사한 JSON을 붙여넣고 **변경 사항 저장**

정책은 이런 모양입니다:

```json
{
  "Version": "2008-10-17",
  "Id": "PolicyForCloudFrontPrivateContent",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipal",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::bookbot-web-20260827/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::<계정ID>:distribution/<배포ID>"
        }
      }
    }
  ]
}
```

> 배너를 닫아버렸다면: CloudFront → 배포 → **오리진** 탭 → 오리진 선택 → **편집** →
> 오리진 액세스 컨트롤 아래의 **정책 복사** 버튼으로 다시 가져올 수 있습니다.

### 9-E. SPA 라우팅용 오류 페이지

React SPA는 `/about` 같은 경로에 실제 파일이 없습니다. S3가 403/404를 반환하는데,
이걸 `index.html`로 돌려줘야 프론트 라우터가 처리할 수 있습니다.

1. 배포 → **오류 페이지** (Error pages) 탭 → **사용자 정의 오류 응답 생성**

**2개를 만듭니다:**

| HTTP 오류 코드 | 오류 캐싱 최소 TTL | 응답 페이지 사용자 지정 | 응답 페이지 경로 | HTTP 응답 코드 |
|---|---|---|---|---|
| `403: Forbidden` | `10` | 예 | `/index.html` | **200: OK** |
| `404: Not Found` | `10` | 예 | `/index.html` | **200: OK** |

### 9-F. 배포 완료 대기

**마지막으로 수정된 날짜**가 "배포 중"에서 날짜로 바뀔 때까지 기다립니다 (5~15분).

### ✅ 체크포인트
- 배포 도메인 이름(`d1234abcd.cloudfront.net`)을 메모했다
- S3 버킷 **권한** 탭에 버킷 정책이 들어갔다
- 오류 페이지 2개가 등록됐다

---

# STEP 10. CloudFront에 `/api/*` 동작 추가 + Lambda OAC ★

여기서 프론트와 백엔드가 하나의 도메인으로 합쳐집니다.
**절차 순서가 중요합니다.** AWS 문서도 "배포를 만든 뒤, OAC를 붙이기 전에 Lambda 권한을 먼저 주라"고 안내합니다.

## 10-A. Lambda 오리진 추가

1. CloudFront → 배포 선택 → **오리진** (Origins) 탭 → **오리진 생성**

| 항목 | 값 |
|---|---|
| 오리진 도메인 | STEP 7의 함수 URL에서 **호스트 부분만**. `https://`와 끝의 `/`를 **반드시 제거** |
| | 예: `abcd1234efgh5678.lambda-url.ap-northeast-2.on.aws` |
| 프로토콜 | **HTTPS만** (HTTPS only) |
| 최소 오리진 SSL 프로토콜 | TLSv1.2 |
| 이름 | `bookbot-lambda-origin` |
| 오리진 액세스 | **Origin access control settings (권장)** |
| → 오리진 액세스 컨트롤 | **새 OAC 생성** → 이름 `bookbot-lambda-oac`, **오리진 유형: Lambda**, 서명 동작 **요청 서명(권장)** → 생성 |
| 응답 시간 초과 (Response timeout) | **`60`** 초 ← 기본 30초면 도구를 여러 번 부를 때 잘립니다 |
| 연결 시도 / 연결 시간 초과 | 기본값 |

2. **오리진 생성**

> ⚠️ OAC 생성 시 **오리진 유형을 반드시 `Lambda`로** 선택하세요.
> S3용 OAC를 Lambda에 붙이면 서명 방식이 달라 403이 납니다.

## 10-B. 배포 ID / ARN 확인

배포의 **일반** 탭에서:
- **배포 도메인 이름**: `d1234abcd.cloudfront.net`
- **ARN**: `arn:aws:cloudfront::<계정ID>:distribution/<배포ID>` ← 복사해두기

## 10-C. Lambda 리소스 기반 정책 추가 ★ 이게 없으면 502/403

CloudFront가 Lambda를 부를 권한을 Lambda 쪽에서 허용해줘야 합니다.

### 방법 1 — 콘솔

1. Lambda → `bookbot-api` → **구성** 탭 → **권한** (Permissions)
2. 아래로 스크롤 → **리소스 기반 정책 명령문** (Resource-based policy statements) → **권한 추가**
3. **AWS 서비스** 선택

| 항목 | 값 |
|---|---|
| 서비스 | **CloudFront** (목록에 없으면 아래 "방법 2" 사용) |
| 명령문 ID | `AllowCloudFrontServicePrincipal` |
| 보안 주체 (Principal) | `cloudfront.amazonaws.com` |
| 소스 ARN | `arn:aws:cloudfront::<계정ID>:distribution/<배포ID>` |
| 작업 (Action) | **`lambda:InvokeFunctionUrl`** ← `lambda:InvokeFunction`이 아닙니다 |

4. **저장**

### 방법 2 — AWS CLI (콘솔 드롭다운에 CloudFront가 없을 때)

콘솔의 서비스 드롭다운에 CloudFront가 없는 경우가 있습니다. 그럴 때는 CLI가 확실합니다.

```bash
aws lambda add-permission \
  --region ap-northeast-2 \
  --function-name bookbot-api \
  --statement-id AllowCloudFrontServicePrincipal \
  --action lambda:InvokeFunctionUrl \
  --principal cloudfront.amazonaws.com \
  --source-arn "arn:aws:cloudfront::<계정ID>:distribution/<배포ID>" \
  --function-url-auth-type AWS_IAM
```

적용 확인:
```bash
aws lambda get-policy --function-name bookbot-api --region ap-northeast-2 \
  --query Policy --output text | python3 -m json.tool
```

> CloudFront 콘솔에서 Lambda용 OAC를 만들면 "이 정책을 Lambda에 추가하세요"라는
> 안내와 함께 정책 JSON을 보여주기도 합니다. 그 값을 써도 동일합니다.

## 10-D. `/api/*` 캐시 동작 생성

1. CloudFront → 배포 → **동작** (Behaviors) 탭 → **동작 생성**

| 항목 | 값 | 이유 |
|---|---|---|
| 경로 패턴 (Path pattern) | **`/api/*`** | |
| 오리진 및 오리진 그룹 | `bookbot-lambda-origin` | |
| 뷰어 프로토콜 정책 | Redirect HTTP to HTTPS | |
| 허용된 HTTP 메서드 | **`GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE`** | POST가 있어야 채팅이 됩니다 |
| 뷰어 액세스 제한 | 아니요 | |
| 캐시 정책 | **CachingDisabled** (관리형) | ★ 응답을 캐싱하면 모든 사용자가 첫 사람의 답변을 받습니다. 스트리밍도 깨집니다 |
| 원본 요청 정책 | **AllViewerExceptHostHeader** (관리형) | ★ Host 헤더를 제외해야 SigV4 서명이 맞습니다. `AllViewer`를 쓰면 403이 납니다 |
| 응답 헤더 정책 | 없음 | |
| 압축 자동 개설 | **아니요 (No)** | ★ SSE 스트림을 압축하면 버퍼링이 생겨 실시간성이 사라집니다 |

2. **동작 생성**
3. **동작** 탭에서 우선순위 확인: `/api/*`가 `Default (*)` 보다 **위**에 있어야 합니다
   (CloudFront는 위에서부터 매칭합니다. 보통 자동으로 위에 배치됩니다.)

## 10-E. 배포 전파 대기 (5~15분)

### ✅ 체크포인트 — API 연결 확인

```bash
curl -s https://<배포도메인>/api/health | python3 -m json.tool
```

기대 응답:
```json
{
  "ok": true,
  "bedrock": { "region": "ap-northeast-2", "modelId": "apac.anthropic..." },
  "table": "bookbot",
  "secrets": { "GOOGLE_BOOKS_API_KEY": true, "HARDCOVER_TOKEN": true, "ALADIN_TTB_KEY": true }
}
```

스트리밍까지 확인:
```bash
curl -N -X POST https://<배포도메인>/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"무료로 읽을 수 있는 고전 추천해줘"}'
```

`data: {"type":"session",...}` → `data: {"type":"tool_start",...}` → `data: {"type":"books",...}` →
`data: {"type":"delta","text":"..."}` 가 **조금씩 흘러나오면** 성공입니다.
`-N` 옵션이 curl의 버퍼링을 끕니다. 한꺼번에 쏟아지면 압축 설정(10-D)을 확인하세요.

### ⚠️ 스트리밍이 CloudFront를 통과하지 않으면 (플랜 B)

정직하게 말하면, **CloudFront를 경유한 SSE 스트리밍은 실제로 테스트해봐야 합니다.**
CloudFront는 응답 본문을 통째로 버퍼링하지 않고 흘려보내도록 설계되어 있고,
캐싱·압축을 끄면 SSE가 정상 동작하는 것이 일반적입니다.
다만 이 조합(CloudFront → OAC → Lambda Function URL → SSE)에 대해
"보장한다"고 명시한 AWS 공식 문서를 찾지는 못했습니다.

위 `curl -N` 테스트에서 **응답이 끝까지 기다린 후 한꺼번에** 나온다면, 순서대로 확인하세요:

1. `/api/*` 동작의 **압축 자동 개설 = 아니요** (10-D)
2. `/api/*` 동작의 **캐시 정책 = CachingDisabled** (10-D)
3. Lambda 함수 URL의 **호출 모드 = RESPONSE_STREAM** (STEP 7)
4. 함수 URL을 직접 테스트해서 Lambda 자체는 스트리밍하는지 분리 확인:
   ```bash
   # 임시로 인증 유형을 NONE으로 바꾸고 테스트한 뒤 반드시 AWS_IAM으로 되돌리세요
   curl -N -X POST '<함수URL>chat' -H 'Content-Type: application/json' \
     -d '{"message":"테스트"}'
   ```
   여기서는 흘러나오는데 CloudFront 경유로는 안 흐른다면 CloudFront 설정 문제입니다.

그래도 안 되면 **두 가지 대안**이 있습니다. 둘 다 코드는 이미 준비돼 있습니다:

**대안 A — 스트리밍 포기, 버퍼 응답으로 전환 (가장 간단)**
- Lambda 핸들러를 `src/index.bufferedHandler`로 변경 (STEP 6-D)
- 함수 URL 호출 모드를 `BUFFERED`로 변경
- 프론트엔드는 그대로 둬도 됩니다. `frontend/src/api.js`가 SSE가 아닌 JSON 응답을
  받으면 `events` 배열을 순차 재생하도록 만들어져 있습니다.
- 잃는 것: 타이핑 효과. 응답이 5~15초 후 한꺼번에 나옵니다.
  대신 "검색 중..." 로딩 표시는 그대로 동작합니다.

**대안 B — 프론트만 CloudFront, API는 함수 URL 직접 호출**
- 함수 URL 인증 유형을 `NONE`으로 변경 (⚠️ 누구나 호출 가능해집니다)
- Lambda 환경 변수 `ALLOWED_ORIGINS=https://<배포도메인>` 추가 → 앱 코드가 CORS 헤더를 붙입니다
- 프론트 `.env`에 `VITE_API_BASE=https://<함수URL호스트>` 설정 후 재빌드
- ⚠️ 이 경우 WAF 보호를 못 받습니다. **STEP 6-G의 예약 동시성(10)과
  `RATE_LIMIT_PER_DAY`를 반드시 낮게 유지**하세요. 2주 데모 한정으로만 쓰세요.

### 자주 막히는 지점

| 증상 | 원인 |
|---|---|
| **403 Forbidden** (본문에 `Missing Authentication Token`) | STEP 10-C 리소스 정책 누락, 또는 Action이 `InvokeFunctionUrl`이 아님 |
| **403** (본문에 SigV4/서명 관련) | 원본 요청 정책이 `AllViewer`로 되어 있음 → `AllViewerExceptHostHeader`로 변경 |
| **502 Bad Gateway** | 오리진 도메인에 `https://`나 끝 슬래시가 포함됨 |
| **504 Gateway Timeout** | 오리진 응답 시간 초과가 30초 → 60초로 변경 (10-A) |
| 응답이 한꺼번에 쏟아짐 | 압축이 켜져 있음, 또는 캐시 정책이 CachingDisabled가 아님 |
| 항상 같은 답변만 나옴 | 캐시 정책이 CachingOptimized로 되어 있음 |
| `/api/health`가 프론트 HTML을 반환 | `/api/*` 동작이 안 만들어졌거나 Default 아래에 있음 |

---

# STEP 11. 프론트엔드 빌드 & 업로드

## 11-A. 빌드

```bash
cd /Users/phontom/Desktop/0827/frontend
npm install
npm run build      # → dist/ 생성
```

> `VITE_API_BASE`는 비워둡니다. CloudFront 단일 도메인이라 프론트가 `/api`를 상대 경로로 호출합니다.

## 11-B. S3 업로드 (콘솔)

1. S3 → `bookbot-web-20260827` → **업로드**
2. `frontend/dist/` 안의 **파일과 폴더를 모두** 끌어다 놓기
   - `index.html` (파일)
   - `assets/` (폴더)
   - 기타 생성된 파일
3. **업로드**

> ⚠️ `dist` 폴더 자체를 올리면 경로가 `dist/index.html`이 되어 404가 납니다.
> **`dist` 안의 내용물**을 버킷 루트에 올려야 합니다.

### 캐시 헤더 최적화 (선택, 권장)

`assets/` 안의 파일들은 파일명에 해시가 붙어 있어 영구 캐싱해도 안전합니다.
반면 `index.html`은 캐싱하면 배포가 반영되지 않습니다.

1. `assets/` 폴더 안의 파일들을 선택 → **작업** → **메타데이터 편집**
   - 유형: 시스템 정의, 키: `Cache-Control`, 값: `public, max-age=31536000, immutable`
2. `index.html` 선택 → **메타데이터 편집**
   - 키: `Cache-Control`, 값: `no-cache`

> CLI가 있으면 훨씬 간단합니다:
> ```bash
> aws s3 sync dist/ s3://bookbot-web-20260827/ --delete \
>   --cache-control "public,max-age=31536000,immutable" --exclude "index.html"
> aws s3 cp dist/index.html s3://bookbot-web-20260827/index.html \
>   --cache-control "no-cache"
> ```

## 11-C. CloudFront 캐시 무효화

업로드 후 CloudFront가 옛 파일을 들고 있을 수 있습니다.

1. CloudFront → 배포 → **무효화** (Invalidations) 탭 → **무효화 생성**
2. 객체 경로: `/*`
3. **무효화 생성** → 1~3분 대기

> 무효화는 월 1,000개 경로까지 무료입니다. 실습 중엔 신경 안 써도 됩니다.

### ✅ 체크포인트
브라우저로 `https://<배포도메인>` 접속 → 챗봇 화면이 뜨고, 예시 질문을 클릭하면
"4개 도서 DB 통합 검색" 진행 표시 → 책 카드 → 답변 텍스트가 순서대로 나옵니다.

브라우저 개발자 도구 **네트워크** 탭에서 `chat` 요청의 유형이 `eventsource`/`fetch`이고
응답이 점진적으로 늘어나면 스트리밍이 제대로 동작하는 것입니다.

---

# STEP 12. AWS WAF (권장)

레이트리밋의 2차 방어선입니다. Lambda까지 도달하기 전에 CloudFront 엣지에서 차단합니다.
비용은 2주에 약 **$3~4**. 비용 폭탄 방지 효과를 생각하면 켜는 게 맞습니다.

1. 콘솔 검색창 → `WAF` → **AWS WAF & Shield**
2. **Web ACLs** → **리전 선택기에서 반드시 `Global (CloudFront)` 선택** ★
3. **Create web ACL**

### 12-A. 기본 정보

| 항목 | 값 |
|---|---|
| 리소스 유형 | **CloudFront distributions** |
| 이름 | `bookbot-waf` |
| CloudWatch 지표 이름 | `bookbot-waf` |
| 연결된 AWS 리소스 | **Add AWS resources** → 우리 배포 선택 |

### 12-B. 규칙 추가

**규칙 1 — 레이트 기반 (가장 중요)**

**Add rules** → **Add my own rules and rule groups** → **Rule builder**

| 항목 | 값 |
|---|---|
| Name | `RateLimitPerIP` |
| Type | **Rate-based rule** |
| Rate limit | **`300`** (5분간 IP당 요청 수) |
| Evaluation window | 5 minutes |
| Request aggregation | **Source IP address** |
| Action | **Block** |

> 300은 정상 사용자에겐 절대 안 걸리고(프론트 정적 파일 요청 포함),
> 스크립트 공격은 확실히 막는 수준입니다.

**규칙 2 — `/api/chat` 전용 강한 제한 (권장)**

| 항목 | 값 |
|---|---|
| Name | `RateLimitChatEndpoint` |
| Type | Rate-based rule |
| Rate limit | **`60`** |
| Evaluation window | 5 minutes |
| Request aggregation | Source IP address |
| Scope of request | **Only consider requests that match the criteria in a rule statement** |
| → Inspect | **URI path** |
| → Match type | **Starts with string** |
| → String to match | `/api/chat` |
| Action | Block |

**규칙 3 — 관리형 공통 규칙 (선택)**

**Add rules** → **Add managed rule groups** → **AWS managed rule groups**
- ☑ **Core rule set (CRS)**
- ☑ **Amazon IP reputation list**

> 관리형 규칙은 요금이 추가되고(규칙 그룹당 약 $1/월), 오탐으로 정상 요청을 막을 수도 있습니다.
> 2주 데모라면 규칙 1, 2만으로도 충분합니다.

4. **기본 웹 ACL 작업**: **Allow** (규칙에 안 걸리면 통과)
5. 규칙 우선순위 기본값 → **Next** → **Create web ACL**

### ✅ 체크포인트
CloudFront → 배포 → **보안** 탭에 `bookbot-waf`가 연결되어 있음.
WAF 콘솔의 해당 Web ACL → **Overview**에서 트래픽 그래프가 그려짐 (몇 분 소요).

---

# STEP 13. 모니터링 & 알람

## 13-A. Lambda 로그 확인 방법

Lambda → `bookbot-api` → **모니터링** 탭 → **CloudWatch 로그 보기**

로그가 JSON 한 줄 형식이라 **Logs Insights**로 쿼리할 수 있습니다.

CloudWatch → **Logs Insights** → 로그 그룹 `/aws/lambda/bookbot-api` 선택:

```
# 요청별 토큰 사용량과 응답 시간
fields @timestamp, msg, totalMs, inputTokens, outputTokens, books
| filter msg = "chat 완료"
| sort @timestamp desc
| limit 50
```

```
# 어떤 도구가 얼마나 쓰였나
fields @timestamp, tool, count, ms
| filter msg = "tool 완료"
| stats count(*) as 호출수, avg(ms) as 평균ms, avg(count) as 평균결과수 by tool
```

```
# 외부 API 실패 추적 (gutendex가 죽었을 때 여기 찍힙니다)
fields @timestamp, msg, label, base, status, reason
| filter level = "warn" or level = "error"
| sort @timestamp desc
| limit 100
```

```
# 레이트리밋에 걸린 IP
fields @timestamp, ip, perMinute, perDay
| filter msg like /rate limit hit/
| stats count(*) as 차단횟수 by ip
| sort 차단횟수 desc
```

## 13-B. 알람 만들기

CloudWatch → **모든 알람** → **알람 생성** 을 반복합니다.

**알람 1 — Lambda 오류**

| 항목 | 값 |
|---|---|
| 지표 | Lambda → 함수별 지표 → `bookbot-api` / **Errors** |
| 통계 | 합계 (Sum) |
| 기간 | 5분 |
| 조건 | 정적, **보다 큼**, 임계값 **`5`** |
| 알림 | SNS 주제 생성 → 이름 `bookbot-alerts` → 본인 이메일 |
| 알람 이름 | `bookbot-lambda-errors` |

> SNS 주제를 처음 만들면 **구독 확인 이메일**이 옵니다. 반드시 링크를 클릭하세요.
> 안 하면 알람이 발생해도 메일이 안 옵니다.

**알람 2 — Lambda 스로틀 (동시성 한도에 걸림 = 트래픽 급증 신호)**

| 항목 | 값 |
|---|---|
| 지표 | Lambda → `bookbot-api` / **Throttles** |
| 통계 / 기간 | 합계 / 5분 |
| 조건 | 보다 큼, `10` |
| 알림 | `bookbot-alerts` |
| 이름 | `bookbot-lambda-throttles` |

**알람 3 — Bedrock 토큰 급증 (비용 조기 경보)**

| 항목 | 값 |
|---|---|
| 지표 | **Bedrock** → By Model → 사용 중인 모델 / **OutputTokenCount** |
| 통계 / 기간 | 합계 / **1시간** |
| 조건 | 보다 큼, **`200000`** (시간당 출력 토큰 20만) |
| 알림 | `bookbot-alerts` |
| 이름 | `bookbot-bedrock-token-spike` |

> 지표가 안 보이면 Bedrock을 최소 한 번 호출한 뒤 5~10분 기다리세요.
> 지표는 첫 사용 후에 생성됩니다.

**알람 4 — 예상 요금 (us-east-1에서만 가능)**

1. CloudWatch 콘솔 우측 상단 리전을 **미국 동부(버지니아 북부) us-east-1**로 변경
2. 알람 생성 → 지표: **결제** (Billing) → **총 예상 요금** → `USD`

| 항목 | 값 |
|---|---|
| 통계 | 최대 (Maximum) |
| 기간 | 6시간 |
| 조건 | 보다 큼, **`50`** USD |
| 알림 | us-east-1에서 SNS 주제를 새로 만들어야 합니다 (`bookbot-alerts-use1`) |
| 이름 | `bookbot-estimated-charges` |

> STEP 0-A에서 "CloudWatch 결제 지표 수신"을 켰어야 이 지표가 보입니다.
> 안 보이면 STEP 0-A로 돌아가서 켠 뒤 최대 24시간 기다려야 할 수 있습니다.

## 13-C. 대시보드 (선택, 운영 중 보기 편함)

CloudWatch → **대시보드** → **대시보드 생성** → 이름 `bookbot`

위젯 5개를 추가하면 한 화면에서 상태를 볼 수 있습니다:

| 위젯 | 지표 |
|---|---|
| 요청 수 | Lambda `Invocations` (합계) |
| 오류율 | Lambda `Errors`, `Throttles` (합계) |
| 응답 시간 | Lambda `Duration` (평균, p99) |
| Bedrock 토큰 | Bedrock `InputTokenCount`, `OutputTokenCount` (합계) |
| CloudFront 트래픽 | CloudFront `Requests`, `BytesDownloaded`, `4xxErrorRate` |

### ✅ 체크포인트
알람 목록에 4개가 있고 상태가 **정상(OK)** 또는 **데이터 부족**.
SNS 구독 확인 메일을 클릭했다.

---

# STEP 14. (선택) Cognito로 로그인 붙이기

**지금 구성은 로그인이 없습니다.** URL을 아는 사람은 누구나 사용할 수 있습니다.
레이트리밋 + WAF + 예약 동시성 + 예산 알림으로 4중 방어를 했으니 2주 데모로는 충분합니다.

하지만 **외부에 링크를 널리 공개할 계획이라면** 로그인을 붙이는 게 맞습니다.
가장 간단한 방법은 CloudFront에서 검사하는 것입니다.

### 개요

1. **Cognito 콘솔** → 사용자 풀 생성
   - 이름 `bookbot-users`, 이메일로 로그인, 셀프 등록 허용
   - 앱 클라이언트: **퍼블릭 클라이언트**, 인증 흐름 `ALLOW_USER_SRP_AUTH`
   - **관리형 로그인**(Hosted UI) 활성화, 콜백 URL = `https://<배포도메인>/`
2. **프론트엔드**에서 Cognito 로그인 → ID 토큰(JWT) 획득
3. `POST /api/chat` 호출 시 `Authorization: Bearer <ID토큰>` 헤더 추가
4. **Lambda 코드**에서 JWT 검증 후 `sub`(사용자 ID)를 레이트리밋 키로 사용
   (IP 대신 사용자 단위 제한 → 훨씬 정확)

> 이 방식으로 바꾸면 `lib/ratelimit.mjs`의 `clientIpFrom()`을 JWT의 `sub`로 교체하고,
> `RATE_LIMIT_PER_DAY`를 사용자당 값으로 재해석하면 됩니다.
>
> 더 간단한 대안: **API Gateway HTTP API + JWT 권한 부여자**를 쓰면 코드 변경 없이
> 토큰 검증을 맡길 수 있습니다. 대신 스트리밍 설정이 추가로 필요합니다
> (핸들러를 `src/index.bufferedHandler`로 바꾸면 스트리밍 없이 바로 동작합니다).

---

# 최종 확인 체크리스트

배포가 끝났으면 아래를 순서대로 확인하세요.

```bash
# 1. 헬스체크 — 설정이 다 들어갔는지
curl -s https://<배포도메인>/api/health | python3 -m json.tool
#    ok:true, secrets 둘 다 true, modelId가 apac.* 인지 확인

# 2. 예시 질문 목록
curl -s https://<배포도메인>/api/config | python3 -m json.tool

# 3. 스트리밍 채팅
curl -N -X POST https://<배포도메인>/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"잔잔하게 위로되는 소설 추천해줘"}'

# 4. 세션 이어가기 (위 응답의 sessionId 사용)
curl -N -X POST https://<배포도메인>/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<위에서 받은 sessionId>","message":"그 중에 제일 짧은 건 뭐야?"}'
#    이전 추천을 기억하고 답하면 DynamoDB 세션이 정상 동작

# 5. 레이트리밋 확인 (11번 연속 호출 → 마지막이 차단되어야 함)
for i in $(seq 1 11); do
  echo -n "$i: "
  curl -s -X POST https://<배포도메인>/api/chat \
    -H 'Content-Type: application/json' -d '{"message":"안녕"}' | head -c 120
  echo
done
```

| 확인 항목 | 통과 기준 |
|---|---|
| 프론트 로딩 | `https://<배포도메인>` 에서 챗봇 UI |
| S3 직접 접근 차단 | `https://bookbot-web-....s3.ap-northeast-2.amazonaws.com/index.html` → **AccessDenied** |
| Lambda URL 직접 접근 차단 | 함수 URL을 브라우저에 입력 → **403 Forbidden** |
| 스트리밍 | 답변이 한 번에 안 나오고 점진적으로 나옴 |
| 도구 호출 | 진행 표시에 "4개 도서 DB 통합 검색" 등이 뜸 |
| 책 카드 | 표지·평점·무드 태그가 보임 |
| 무료 전자책 | "무료 고전 추천" 요청 시 다운로드 버튼이 있는 카드 |
| 세션 기억 | 후속 질문에서 이전 추천을 참조 |
| 레이트리밋 | 11번째 요청에서 차단 메시지 |
| 알람 | CloudWatch 알람 4개, SNS 구독 확인 완료 |
| 예산 | 예산 2개 등록 |

---

# 다음 문서

- [03-external-apis.md](./03-external-apis.md) — 도서 API 4종 키 발급과 연동 전략
- [04-cost-and-cleanup.md](./04-cost-and-cleanup.md) — 2주 비용 추정과 **삭제 순서** (반드시 읽으세요)
- [05-runbook.md](./05-runbook.md) — 코드 수정 후 재배포, 트러블슈팅
