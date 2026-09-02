#!/usr/bin/env bash
#
# 사전 점검 — 배포 전에 "사람만 할 수 있는 일"이 끝났는지 확인합니다.
#
# CLI로 자동화할 수 없는 것이 3가지 있습니다:
#   1. Bedrock 모델 액세스 승인 (Anthropic 모델은 사용 사례 양식 제출이 필요 — 콘솔 전용)
#   2. Google Books API 키 발급 (Google Cloud Console)
#   3. Hardcover 토큰 발급 (hardcover.app)
#
# 나머지는 전부 자동화됩니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "사전 점검"

PROBLEMS=0
BLOCKERS=0

# secrets.env를 가장 먼저 읽습니다.
# (BEDROCK_MODEL_ID가 여기 들어있으므로 Bedrock 검사보다 앞서야 합니다)
load_secrets
if [ -f "$SECRETS_FILE" ]; then
  ok "설정 파일 로드: infra/secrets.env"
else
  warn "infra/secrets.env 가 없습니다"
  info "  cp infra/secrets.env.example infra/secrets.env  후 값을 채우세요"
fi

# ── 1. 로컬 도구 ────────────────────────────────────────────
step "로컬 도구"
require_cli
ok "aws  $(aws --version 2>&1 | cut -d' ' -f1)"
ok "node $(node --version)"
ok "python3 $(python3 --version 2>&1 | cut -d' ' -f2)"

# ── 2. AWS 자격증명 ─────────────────────────────────────────
step "AWS 자격증명"
require_creds
ok "계정 ID: $ACCOUNT_ID"
info "호출 주체: $CALLER_ARN"
info "배포 리전: $REGION   (Lambda / DynamoDB / SSM 공통)"
info "Bedrock  : $BEDROCK_REGION"

# 권한 확인 — 필요한 서비스에 접근 가능한지 가볍게 찔러봅니다
step "IAM 권한 확인"
check_perm() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    ok "$label"
  else
    fail "$label — 권한이 없거나 서비스 접근 불가"
    PROBLEMS=$((PROBLEMS + 1))
  fi
}
check_perm "IAM (역할/정책 생성)"      aws iam list-roles --max-items 1
check_perm "Lambda"                    aws lambda list-functions --max-items 1 --region "$REGION"
check_perm "DynamoDB"                  aws dynamodb list-tables --max-items 1 --region "$REGION"
check_perm "S3"                        aws s3api list-buckets
check_perm "CloudFront"                aws cloudfront list-distributions
check_perm "SSM Parameter Store"       aws ssm describe-parameters --max-results 1 --region "$REGION"
check_perm "CloudWatch"                aws cloudwatch describe-alarms --max-records 1 --region "$REGION"
check_perm "SNS"                       aws sns list-topics --region "$REGION"

# ── 3. Bedrock 모델 액세스 (자동화 불가 — 확인만) ─────────────
step "Bedrock 모델 액세스"
if ! aws bedrock list-foundation-models --region "$BEDROCK_REGION" >/dev/null 2>&1; then
  fail "Bedrock에 접근할 수 없습니다 (리전: $BEDROCK_REGION)"
  BLOCKERS=$((BLOCKERS + 1))
else
  ok "Bedrock API 접근 가능"

  # 사용 가능한 Anthropic 추론 프로필 목록
  PROFILES="$(aws bedrock list-inference-profiles \
    --region "$BEDROCK_REGION" --type-equals SYSTEM_DEFINED \
    --query "inferenceProfileSummaries[?contains(inferenceProfileId,'anthropic')].inferenceProfileId" \
    --output text 2>/dev/null || true)"

  if [ -n "$PROFILES" ]; then
    ok "사용 가능한 Anthropic 추론 프로필:"
    printf '%s\n' "$PROFILES" | tr '\t' '\n' | sed 's/^/      /'
  else
    warn "추론 프로필 목록을 가져오지 못했습니다 (권한 또는 리전 문제)"
  fi

  # 실제 호출 테스트 — 모델 액세스 승인 여부를 확인하는 유일하게 확실한 방법
  if [ -n "${BEDROCK_MODEL_ID:-}" ]; then
    info "지정된 모델로 호출 테스트: $BEDROCK_MODEL_ID"
    if aws bedrock-runtime converse \
        --region "$BEDROCK_REGION" \
        --model-id "$BEDROCK_MODEL_ID" \
        --messages '[{"role":"user","content":[{"text":"hi"}]}]' \
        --inference-config '{"maxTokens":5}' >/dev/null 2>"$INFRA_DIR/.bedrock-err"; then
      ok "모델 호출 성공 — 액세스 승인됨"
    else
      fail "모델 호출 실패:"
      sed 's/^/      /' "$INFRA_DIR/.bedrock-err" | head -5
      BLOCKERS=$((BLOCKERS + 1))
    fi
    rm -f "$INFRA_DIR/.bedrock-err"
  else
    warn "BEDROCK_MODEL_ID가 지정되지 않았습니다."
    info "위 목록에서 하나를 골라 infra/secrets.env 에 넣으세요. 예:"
    info '  BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    BLOCKERS=$((BLOCKERS + 1))
  fi
fi

# ── 4. 도서 API 키 (자동화 불가 — 확인만) ────────────────────
step "도서 API 키"
load_secrets

if [ -n "$GOOGLE_BOOKS_API_KEY" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
    "https://www.googleapis.com/books/v1/volumes?q=test&country=KR&maxResults=1&key=$GOOGLE_BOOKS_API_KEY")"
  case "$CODE" in
    200) ok "Google Books 키 유효" ;;
    403) fail "Google Books 403 — Google Cloud Console에서 'Books API' 사용 설정을 확인하세요"
         PROBLEMS=$((PROBLEMS + 1)) ;;
    429) warn "Google Books 429 — 일일 쿼터 초과 (키 자체는 유효할 수 있음)" ;;
    *)   fail "Google Books 응답 코드 $CODE"; PROBLEMS=$((PROBLEMS + 1)) ;;
  esac
else
  warn "GOOGLE_BOOKS_API_KEY 없음 — 이 소스 없이도 동작하지만 검색 품질이 크게 떨어집니다"
  PROBLEMS=$((PROBLEMS + 1))
fi

if [ -n "$HARDCOVER_TOKEN" ]; then
  HC_AUTH="$HARDCOVER_TOKEN"
  case "$HC_AUTH" in Bearer\ *) : ;; *) HC_AUTH="Bearer $HC_AUTH" ;; esac
  HC_BODY="$(curl -s -m 15 https://api.hardcover.app/v1/graphql \
    -H "Authorization: $HC_AUTH" -H 'Content-Type: application/json' \
    -d '{"query":"query { search(query: \"dune\", query_type: \"Book\", per_page: 1, page: 1) { results } }"}' 2>/dev/null)"
  if printf '%s' "$HC_BODY" | grep -q '"data"'; then
    ok "Hardcover 토큰 유효 (무드/평점 데이터 사용 가능)"
  else
    fail "Hardcover 호출 실패: $(printf '%s' "$HC_BODY" | head -c 200)"
    PROBLEMS=$((PROBLEMS + 1))
  fi
else
  warn "HARDCOVER_TOKEN 없음 — 무드/콘텐츠 경고 기능을 쓸 수 없습니다"
  PROBLEMS=$((PROBLEMS + 1))
fi

# ── 5. 기존 리소스 확인 ─────────────────────────────────────
step "기존 리소스 (재실행 시 건너뛸 대상)"
resolve_bucket_name
ddb_table_exists  && info "DynamoDB $TABLE_NAME 있음"        || info "DynamoDB $TABLE_NAME 없음 → 생성 예정"
role_exists       && info "IAM 역할 $ROLE_NAME 있음"          || info "IAM 역할 $ROLE_NAME 없음 → 생성 예정"
lambda_exists     && info "Lambda $FUNCTION_NAME 있음"        || info "Lambda $FUNCTION_NAME 없음 → 생성 예정"
bucket_exists     && info "S3 $BUCKET_NAME 있음"              || info "S3 $BUCKET_NAME 없음 → 생성 예정"

DIST_ID="$(state_get DISTRIBUTION_ID)"
[ -n "$DIST_ID" ] && info "CloudFront $DIST_ID 있음" || info "CloudFront 없음 → 생성 예정"

# 다른 리전에 만들어둔 Lambda가 있는지 경고
step "리전 불일치 확인"
FOUND_OTHER=0
for r in us-east-1 us-west-2 ap-northeast-1 ap-northeast-2 eu-west-1; do
  [ "$r" = "$REGION" ] && continue
  if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$r" >/dev/null 2>&1; then
    warn "리전 $r 에도 $FUNCTION_NAME 함수가 있습니다."
    info "  → 중복 리소스입니다. 배포 후 정리하세요:"
    info "    aws lambda delete-function --function-name $FUNCTION_NAME --region $r"
    FOUND_OTHER=1
  fi
done
[ $FOUND_OTHER -eq 0 ] && ok "다른 리전에 중복 함수 없음"

# ── 결과 ────────────────────────────────────────────────────
header "점검 결과"

if [ $BLOCKERS -gt 0 ]; then
  fail "배포를 진행할 수 없습니다 (필수 항목 $BLOCKERS 개 미충족)"
  cat <<EOF

  ${C_BLD}사람이 직접 해야 하는 일 (CLI로 자동화 불가):${C_RST}

  1. Bedrock 모델 액세스 승인
     https://console.aws.amazon.com/bedrock/home?region=$BEDROCK_REGION#/modelaccess
     → "모델 액세스 수정" → Anthropic Claude 체크 → 사용 사례 양식 제출
     (Anthropic 모델은 양식 제출이 필수라 API로 자동화할 수 없습니다)

  2. 모델 ID 확인 후 infra/secrets.env 에 기록
     위 "사용 가능한 Anthropic 추론 프로필" 목록에서 고르세요

  끝난 뒤 다시 실행: bash infra/00-preflight.sh

EOF
  exit 1
fi

if [ $PROBLEMS -gt 0 ]; then
  warn "경고 $PROBLEMS 건 — 배포는 가능하지만 기능이 제한됩니다"
  info "도서 API 키를 채우려면: infra/secrets.env 편집 후 재실행"
else
  ok "모든 점검 통과"
fi

printf '\n  다음 단계:  %sbash infra/deploy-all.sh%s\n\n' "$C_BLD" "$C_RST"
