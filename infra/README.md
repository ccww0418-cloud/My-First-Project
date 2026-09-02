# infra — AWS CLI 자동 배포

콘솔 클릭 없이 전체 스택을 배포합니다. 모든 스크립트는 **idempotent**해서 여러 번 실행해도 안전합니다.

## 한 번만 준비할 것

```bash
# 1) 자격증명 상태 진단 — 무엇을 해야 하는지 알려줍니다
bash infra/setup-credentials.sh

# 2) 위 안내에 따라 설정 (본인 터미널에서 직접 — 키를 어디에도 붙여넣지 마세요)
aws configure          # IAM 사용자 액세스 키
# 또는
aws configure sso      # IAM Identity Center(SSO)

aws sts get-caller-identity     # 확인

# 3) 설정 파일에 값 채우기
#   infra/secrets.env
#     BEDROCK_MODEL_ID       ← 필수
#     GOOGLE_BOOKS_API_KEY   ← 권장
#     HARDCOVER_TOKEN        ← 권장
#     ALERT_EMAIL            ← 권장
```

> ⚠️ **Kiro IDE 로그인은 AWS CLI 자격증명이 아닙니다.**
> `~/.aws/sso/cache/kiro-auth-token.json`이 있어도 `aws sts get-caller-identity`는 실패합니다.
> 용도와 스코프가 달라서 인프라 프로비저닝에 쓸 수 없습니다. 위 2번을 따로 해야 합니다.

## 배포 — 명령 하나

```bash
bash infra/go.sh
```

이것만 실행하면 됩니다. 순서대로 다 합니다:

1. **AWS 로그인 대기** — 자격증명이 없으면 안내를 띄우고 기다립니다.
   다른 터미널에서 `aws configure`를 마치면 자동으로 감지해서 이어집니다.
2. **Bedrock 모델 자동 선택** — 사용 가능한 모델을 수집·정렬하고 실제로 호출해봐서
   액세스 승인된 것을 찾아 `secrets.env`에 기록합니다.
3. 사전 점검
4. 전체 배포
5. 검증 (전파 대기 → 실제 채팅 → 보안 → 레이트리밋)

```bash
PREFER=sonnet bash infra/go.sh    # 품질 우선 (기본은 비용 우선 haiku)
SKIP_WAF=1    bash infra/go.sh    # WAF 생략 (2주 약 $3.5 절약)
NO_WAIT=1     bash infra/go.sh    # 로그인 대기 없이 즉시 실패
```

### 단계별로 실행하고 싶다면

| 스크립트 | 하는 일 |
|---|---|
| `setup-credentials.sh` | (진단만) 자격증명 상태를 읽고 상황별 설정 방법 안내 |
| `select-model.sh` | Bedrock 모델 자동 선택. `PREFER=list`면 목록만 출력 |
| `00-preflight.sh` | (점검만) 도구·자격증명·권한·Bedrock 액세스·도서 API 키·리전 불일치 |
| `01-backend.sh` | DynamoDB + TTL, SSM 파라미터, IAM 정책/역할, Lambda, Function URL, 예약 동시성, 로그 보존 |
| `02-frontend.sh` | S3 버킷(비공개), Vite 빌드, 캐시 헤더 분리 업로드 |
| `03-cloudfront.sh` | OAC 2개, 배포(오리진 2개 + `/api/*` 동작), S3 버킷 정책, Lambda 리소스 정책, 무효화 |
| `04-guardrails.sh` | WAF(레이트 기반 2규칙), SNS, CloudWatch 알람 4개, Budgets 2개 |
| `deploy-all.sh` | 01~04를 순서대로 (모델 자동 선택·로그인 대기 없음) |
| `verify.sh` | 전파 대기 → 헬스체크 → 스트리밍 채팅 → 직접접근 차단 → 레이트리밋 |
| `destroy.sh` | 전체 삭제 (의존 순서대로) |

## 옵션

```bash
REGION=ap-northeast-2 bash infra/deploy-all.sh   # 서울에 배포
SKIP_WAF=1 bash infra/deploy-all.sh              # WAF 생략 (2주 약 $3.5 절약)
BUDGET_LIMIT=50 bash infra/deploy-all.sh         # 예산 상한 변경
FORCE=1 bash infra/destroy.sh                    # 확인 프롬프트 없이 삭제
```

## 코드만 다시 올리기

```bash
bash infra/01-backend.sh    # 백엔드 수정 후
bash infra/02-frontend.sh && \
  aws cloudfront create-invalidation \
    --distribution-id "$(grep DISTRIBUTION_ID infra/.state | cut -d= -f2)" --paths '/*'
```

---

## CLI로 자동화할 수 없는 것 (3가지)

나머지는 전부 자동화됩니다. 이 3개만 사람이 직접 해야 합니다.

### 1. Bedrock 모델 액세스 승인
Anthropic 모델은 **사용 사례 양식 제출**이 필요하고, 이 양식에는 공개 API가 없습니다.

https://console.aws.amazon.com/bedrock/home#/modelaccess
→ "모델 액세스 수정" → Anthropic Claude 체크 → 양식 제출 (보통 즉시~수 분 승인)

승인 후 사용 가능한 모델 ID 확인:
```bash
bash infra/00-preflight.sh      # "사용 가능한 Anthropic 추론 프로필" 목록을 보여줍니다
```

> 리전별 접두사가 다릅니다. `us-east-1` → `us.*`, `ap-northeast-2` → `apac.*`.
> 버전 접미사(`-v1:0`)까지 포함한 **전체 문자열**을 넣어야 합니다.

### 2. Google Books API 키
Google Cloud Console → 프로젝트 생성 → **"Books API" 사용 설정** → 사용자 인증 정보 → API 키
(사용 설정을 빼먹으면 403이 납니다. 가장 흔한 실수)

### 3. Hardcover 토큰
https://hardcover.app/account/api

자세한 절차: [../docs/03-external-apis.md](../docs/03-external-apis.md)

---

## 상태 파일

`infra/.state`에 생성된 리소스 ID가 기록됩니다. 스크립트 간에 값을 주고받는 용도입니다.

```
BUCKET_NAME=bookbot-web-123456789012-us-east-1
FUNCTION_URL=https://xxxx.lambda-url.us-east-1.on.aws/
FUNCTION_URL_HOST=xxxx.lambda-url.us-east-1.on.aws
DISTRIBUTION_ID=E1XXXXXXXXXX
DISTRIBUTION_DOMAIN=dxxxxxxxxxx.cloudfront.net
SITE_URL=https://dxxxxxxxxxx.cloudfront.net
```

`.gitignore`에 등록되어 있습니다. 이 파일을 지우면 스크립트가 리소스를 새로 만들려고 하니 주의하세요.

---

## 설계 노트

**왜 idempotent인가** — 실습은 중간에 실패합니다. 모델 액세스가 늦게 승인되거나 키가 틀리거나.
매번 처음부터 다시 만들 수 있으면 부담 없이 재시도할 수 있습니다.
모든 생성 작업 전에 존재 여부를 확인하고, 있으면 갱신하거나 건너뜁니다.

**왜 리전을 `*`로 둔 IAM 정책인가** — Bedrock 교차 리전 추론 프로필은 요청이 다른 리전으로
라우팅되므로 리전을 고정하면 실패합니다. 또한 Lambda를 다른 리전에 만들었을 때
정책이 조용히 거부해서 몇 시간을 헤매는 함정을 막습니다.
계정 ID와 리소스 이름으로는 여전히 좁혀져 있습니다.

**왜 JSON 생성에 셸 보간을 쓰지 않는가** — `03-cloudfront.sh`는 heredoc을 `<<'PY'`로 인용하고
값을 환경 변수로 넘깁니다. 셸 보간을 섞으면 값에 특수문자가 들어갈 때 조용히 깨집니다.
생성 직후 `assert`로 자기 검증도 합니다 (캐시 off, 압축 off, POST 허용, 타임아웃 60초,
Lambda 오리진에 `https://` 없음).

**bash 3.2 호환** — macOS 기본 bash는 3.2입니다. `set -u`에서 빈 배열을 `"${arr[@]}"`로
확장하면 죽기 때문에 배열 사용을 피했습니다.

**`set -e`를 쓰지 않는 이유** — 일부 실패(WAF, 예산, 알람)는 치명적이지 않습니다.
중요한 지점에만 `|| die`를 붙여서, 부수적 실패로 전체가 중단되지 않게 했습니다.
