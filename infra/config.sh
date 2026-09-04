#!/usr/bin/env bash
#
# 공통 설정 + 헬퍼 함수. 모든 스크립트가 이 파일을 source 합니다.
#
# 값을 바꾸고 싶으면 환경 변수로 덮어쓰세요:
#   REGION=ap-northeast-2 bash infra/deploy-all.sh
# ============================================================

# ── 리전 ────────────────────────────────────────────────────
# Lambda / DynamoDB / SSM 은 반드시 같은 리전이어야 합니다.
# 기본값을 us-east-1로 둔 이유: Bedrock 모델 종류가 가장 많고,
# 이미 us-east-1에 함수를 만들어 두셨다면 Bedrock 모델 액세스를 다시 받지 않아도 됩니다.
export REGION="${REGION:-us-east-1}"

# Bedrock만 다른 리전을 쓸 수 있습니다 (모델 가용성 때문에).
export BEDROCK_REGION="${BEDROCK_REGION:-$REGION}"

# ── 리소스 이름 ─────────────────────────────────────────────
export PROJECT="${PROJECT:-bookbot}"
export TABLE_NAME="${TABLE_NAME:-${PROJECT}}"
export FUNCTION_NAME="${FUNCTION_NAME:-${PROJECT}-api}"
export ROLE_NAME="${ROLE_NAME:-${PROJECT}-lambda-role}"
export POLICY_NAME="${POLICY_NAME:-${PROJECT}-lambda-policy}"
export SSM_PREFIX="${SSM_PREFIX:-/${PROJECT}/prod}"
export WAF_NAME="${WAF_NAME:-${PROJECT}-waf}"
export SNS_TOPIC_NAME="${SNS_TOPIC_NAME:-${PROJECT}-alerts}"

# ── Lambda 설정 ─────────────────────────────────────────────
export LAMBDA_RUNTIME="nodejs22.x"
export LAMBDA_ARCH="arm64"
export LAMBDA_HANDLER="src/index.handler"
export LAMBDA_MEMORY="1024"
export LAMBDA_TIMEOUT="90"
# 예약 동시성 — 비용 방어 3층입니다.
#
#   숫자   그 값으로 예약 (미예약분이 부족하면 자동으로 낮춥니다)
#   none   예약을 **삭제**합니다. 계정 미예약 풀(보통 1,000)을 함께 씁니다
#
# ⚠️ none 으로 두면 이 함수가 계정 한도까지 확장될 수 있습니다. 공개
#    엔드포인트 + Bedrock 조합이라 노출이 커집니다. 벤치마크처럼 동시 요청이
#    많은 작업에만 쓰고 끝나면 숫자로 되돌리세요.
#    남는 방어: 앱 레이트리밋(IP별) · WAF(5분당 300) · Budgets($100 / Bedrock $50)
export LAMBDA_RESERVED_CONCURRENCY="${LAMBDA_RESERVED_CONCURRENCY:-none}"

# ── 앱 동작 설정 ────────────────────────────────────────────
export RATE_LIMIT_PER_MINUTE="${RATE_LIMIT_PER_MINUTE:-10}"
export RATE_LIMIT_PER_DAY="${RATE_LIMIT_PER_DAY:-150}"
export MAX_TOOL_ITERATIONS="${MAX_TOOL_ITERATIONS:-4}"

# OpenAI 호환 경로(GuardBench Target)는 카운터가 따로입니다 — RLOAI#<ip>.
#
# 왜 채팅(10/분)보다 높은가: 벤치마크 한 실행이 TestCase 수십 건을 **동시에**
# 던집니다. 그리고 4xx 는 GuardBench 에서 재시도 대상이 아니라(isRetryable=false)
# 429 를 한 번 받으면 그 케이스는 영구 실패로 남습니다.
#
# 41건 × 재시도 3회 = 최대 123건이 한 분에 몰릴 수 있어 150 으로 둡니다.
# 하루 상한(600)이 실질 비용 뚜껑입니다.
export OPENAI_RATE_LIMIT_PER_MINUTE="${OPENAI_RATE_LIMIT_PER_MINUTE:-150}"
export OPENAI_RATE_LIMIT_PER_DAY="${OPENAI_RATE_LIMIT_PER_DAY:-600}"

# ── 정책 판정 (GuardBench 연동) ──────────────────────────────
# POLICY_LLM_CHECK=0  이면 규칙 기반만 사용 (Bedrock 추가 호출 없음, 주제 판정 불가)
# POLICY_BLOCK_VALUE  GuardBench 스펙의 차단 값 (DENY/REJECT 등이면 변경)
# POLICY_FAIL_CLOSED=1 이면 분류기 장애 시 차단 (기본은 허용 = 가용성 우선)
export POLICY_LLM_CHECK="${POLICY_LLM_CHECK:-1}"
export POLICY_BLOCK_VALUE="${POLICY_BLOCK_VALUE:-BLOCK}"
export POLICY_FAIL_CLOSED="${POLICY_FAIL_CLOSED:-0}"
# 3072 — 추천 10권 이상이면 한국어 답변이 1400자까지 갑니다.
# 2048 에서는 답변이 잘려서 카드 선별까지 어긋났습니다.
export BEDROCK_MAX_TOKENS="${BEDROCK_MAX_TOKENS:-3072}"
export BEDROCK_TEMPERATURE="${BEDROCK_TEMPERATURE:-0.4}"

# ── 경로 ────────────────────────────────────────────────────
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export INFRA_DIR
export ROOT_DIR="$(dirname "$INFRA_DIR")"
export BACKEND_DIR="$ROOT_DIR/backend"
export FRONTEND_DIR="$ROOT_DIR/frontend"
export STATE_FILE="$INFRA_DIR/.state"
export SECRETS_FILE="$INFRA_DIR/secrets.env"

# Homebrew node@22 는 PATH에 자동 등록되지 않습니다
if [ -d /opt/homebrew/opt/node@22/bin ]; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

# CLI 페이저 비활성화 (스크립트가 멈추는 것 방지)
export AWS_PAGER=""

# ============================================================
# MFA 프로필 자동 감지
#
# MFA 강제 정책(예: aws:MultiFactorAuthPresent=false 조건의 Deny)이 걸린 계정에서는
# 장기 액세스 키만으로는 아무 작업도 못 합니다.
# infra/mfa-login.sh 가 [bookbot-mfa] 프로필에 MFA 인증된 임시 자격증명을 저장하면,
# 여기서 자동으로 감지해 모든 스크립트가 그 프로필을 쓰게 만듭니다.
# ============================================================
if [ -z "${AWS_PROFILE:-}" ] && [ -f "$HOME/.aws/credentials" ] \
   && grep -q '^\[bookbot-mfa\]' "$HOME/.aws/credentials" 2>/dev/null; then
  _MFA_EXPIRY_FILE="$INFRA_DIR/.mfa-expiry"
  _MFA_VALID=1
  if [ -f "$_MFA_EXPIRY_FILE" ]; then
    # 만료되었으면 쓰지 않습니다 (혼란스러운 에러 대신 명확한 안내를 위해)
    _MFA_VALID="$(python3 -c "
import datetime, sys
try:
    raw = open('$_MFA_EXPIRY_FILE').read().strip().replace('Z', '+00:00')
    exp = datetime.datetime.fromisoformat(raw)
    now = datetime.datetime.now(datetime.timezone.utc)
    print(1 if exp > now + datetime.timedelta(minutes=2) else 0)
except Exception:
    print(1)
" 2>/dev/null || echo 1)"
  fi
  if [ "$_MFA_VALID" = "1" ]; then
    export AWS_PROFILE="bookbot-mfa"
  else
    printf '  \033[33m!\033[0m MFA 세션이 만료되었습니다. 갱신하세요:  bash infra/mfa-login.sh <6자리코드>\n' >&2
  fi
  unset _MFA_EXPIRY_FILE _MFA_VALID
fi

# ============================================================
# 출력 헬퍼
# ============================================================
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_DIM=""; C_BLD=""; C_RST=""
fi

step()  { printf '\n%s▶ %s%s\n' "$C_BLD$C_BLU" "$*" "$C_RST"; }
ok()    { printf '  %s✓%s %s\n' "$C_GRN" "$C_RST" "$*"; }
skip()  { printf '  %s•%s %s %s(이미 존재 — 건너뜀)%s\n' "$C_DIM" "$C_RST" "$*" "$C_DIM" "$C_RST"; }
info()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RST"; }
warn()  { printf '  %s!%s %s\n' "$C_YEL" "$C_RST" "$*"; }
fail()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RST" "$*"; }
die()   { fail "$*"; exit 1; }

header() {
  printf '\n%s%s\n' "$C_BLD" "════════════════════════════════════════════════════════════"
  printf '  %s\n' "$*"
  printf '%s%s\n' "════════════════════════════════════════════════════════════" "$C_RST"
}

# ============================================================
# 상태 파일 — 스크립트 간에 값을 주고받습니다 (배포ID, 함수URL 등)
# ============================================================
state_set() {
  local key="$1" value="$2"
  touch "$STATE_FILE"
  # 기존 키 제거 후 추가 (macOS sed 호환)
  grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
  mv "${STATE_FILE}.tmp" "$STATE_FILE"
  printf '%s=%s\n' "$key" "$value" >> "$STATE_FILE"
}

state_get() {
  [ -f "$STATE_FILE" ] || return 0
  grep "^${1}=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2-
}

state_load() {
  [ -f "$STATE_FILE" ] || return 0
  # shellcheck disable=SC1090
  set -a; source "$STATE_FILE"; set +a
}

# ============================================================
# 사전 조건 확인
# ============================================================
require_cli() {
  command -v aws >/dev/null 2>&1 || die "AWS CLI가 없습니다.  brew install awscli"
  command -v node >/dev/null 2>&1 || die "Node.js가 없습니다.  brew install node@22"
  command -v python3 >/dev/null 2>&1 || die "python3가 필요합니다."
  command -v zip >/dev/null 2>&1 || die "zip이 필요합니다."
}

require_creds() {
  if ! ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"; then
    fail "AWS 자격증명이 없습니다."
    cat <<'EOF'

  터미널에서 아래 중 하나를 실행한 뒤 다시 시도하세요:

    aws configure
      → Access Key ID / Secret Access Key / region / output(json) 입력

    또는 IAM Identity Center(SSO)를 쓰는 경우:
    aws configure sso

  확인:
    aws sts get-caller-identity

EOF
    exit 1
  fi
  export ACCOUNT_ID
  export CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
}

# S3 버킷 이름은 전 세계에서 유일해야 하므로 계정 ID를 붙입니다
resolve_bucket_name() {
  local existing
  existing="$(state_get BUCKET_NAME)"
  if [ -n "$existing" ]; then
    export BUCKET_NAME="$existing"
  else
    export BUCKET_NAME="${BUCKET_NAME:-${PROJECT}-web-${ACCOUNT_ID}-${REGION}}"
    state_set BUCKET_NAME "$BUCKET_NAME"
  fi
}

# ============================================================
# 도서 API 키 로딩
# ============================================================
load_secrets() {
  if [ -f "$SECRETS_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; source "$SECRETS_FILE"; set +a
  fi
  export GOOGLE_BOOKS_API_KEY="${GOOGLE_BOOKS_API_KEY:-}"
  export HARDCOVER_TOKEN="${HARDCOVER_TOKEN:-}"
  export ALADIN_TTB_KEY="${ALADIN_TTB_KEY:-}"
  export NLK_API_KEY="${NLK_API_KEY:-}"
  export BEDROCK_MODEL_ID="${BEDROCK_MODEL_ID:-}"
  export ALERT_EMAIL="${ALERT_EMAIL:-}"
  export CONTACT_EMAIL="${CONTACT_EMAIL:-}"
}

# ============================================================
# 리소스 존재 확인 헬퍼 (전부 idempotent 하게 만들기 위함)
# ============================================================
ddb_table_exists() {
  aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1
}
lambda_exists() {
  aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1
}
role_exists() {
  aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1
}
bucket_exists() {
  aws s3api head-bucket --bucket "$BUCKET_NAME" >/dev/null 2>&1
}
policy_arn() {
  printf 'arn:aws:iam::%s:policy/%s' "$ACCOUNT_ID" "$POLICY_NAME"
}
policy_exists() {
  aws iam get-policy --policy-arn "$(policy_arn)" >/dev/null 2>&1
}
