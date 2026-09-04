#!/usr/bin/env bash
#
# 백엔드 배포: DynamoDB → SSM → IAM → Lambda → Function URL
#
# 전부 idempotent 합니다. 여러 번 실행해도 안전하고, 이미 있는 것은 건너뛰거나 갱신합니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "1/4  백엔드 (DynamoDB · SSM · IAM · Lambda)"

require_cli
require_creds
load_secrets
state_load

# ────────────────────────────────────────────────────────────
step "DynamoDB 테이블 — 단일 테이블(세션/캐시/레이트리밋)"
# ────────────────────────────────────────────────────────────
if ddb_table_exists; then
  skip "테이블 $TABLE_NAME"
else
  aws dynamodb create-table \
    --region "$REGION" \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Project,Value="$PROJECT" \
    >/dev/null || die "테이블 생성 실패"
  info "테이블 활성화 대기..."
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
  ok "테이블 $TABLE_NAME 생성 (온디맨드)"
fi

# TTL — 이걸 켜야 세션/캐시/레이트리밋 데이터가 자동 삭제됩니다
TTL_STATUS="$(aws dynamodb describe-time-to-live \
  --table-name "$TABLE_NAME" --region "$REGION" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || echo NONE)"

if [ "$TTL_STATUS" = "ENABLED" ] || [ "$TTL_STATUS" = "ENABLING" ]; then
  skip "TTL (속성 ttl)"
else
  aws dynamodb update-time-to-live \
    --region "$REGION" --table-name "$TABLE_NAME" \
    --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null \
    && ok "TTL 활성화 (속성명 ttl)" \
    || warn "TTL 설정 실패 — 콘솔에서 수동 설정하세요"
fi

# ────────────────────────────────────────────────────────────
step "SSM Parameter Store — 도서 API 키 (SecureString)"
# ────────────────────────────────────────────────────────────
put_param() {
  local name="$1" value="$2" label="$3"
  if [ -z "$value" ]; then
    warn "$label 값이 비어 있어 건너뜁니다 (infra/secrets.env 확인)"
    return
  fi
  aws ssm put-parameter \
    --region "$REGION" \
    --name "$name" \
    --value "$value" \
    --type SecureString \
    --key-id "alias/aws/ssm" \
    --overwrite \
    --tier Standard \
    >/dev/null && ok "$label → $name" || fail "$label 저장 실패"
}

put_param "$SSM_PREFIX/GOOGLE_BOOKS_API_KEY" "$GOOGLE_BOOKS_API_KEY" "Google Books 키"
put_param "$SSM_PREFIX/HARDCOVER_TOKEN"      "$HARDCOVER_TOKEN"      "Hardcover 토큰"
put_param "$SSM_PREFIX/ALADIN_TTB_KEY"       "${ALADIN_TTB_KEY:-}"   "알라딘 TTB 키 (국내 도서)"
put_param "$SSM_PREFIX/NLK_API_KEY"          "${NLK_API_KEY:-}"      "국립중앙도서관 키 (국내 서지)"

# ── 오리진 비밀 — 함수 URL 직접 호출 차단용 ──────────────
#
# 왜 필요한가:
#   CloudFront OAC + Lambda 함수 URL 조합은 **본문이 있는 POST를 지원하지 않습니다.**
#   AWS 문서: "If you use PUT or POST methods with your Lambda function URL, your users
#   must compute the SHA256 of the body and include the payload hash value in the
#   x-amz-content-sha256 header. Lambda doesn't support unsigned payloads."
#   → 브라우저가 SigV4 서명을 해야 하므로 공개 웹앱에서는 불가능합니다.
#
#   그래서 함수 URL 인증을 NONE으로 두고, CloudFront가 오리진으로만 전송하는
#   커스텀 헤더(x-origin-secret)로 인증합니다. 이 헤더는 브라우저에 노출되지 않습니다.
if EXISTING_SECRET="$(aws ssm get-parameter --region "$REGION" \
    --name "$SSM_PREFIX/ORIGIN_SECRET" --with-decryption \
    --query 'Parameter.Value' --output text 2>/dev/null)"; then
  skip "오리진 비밀 (기존 값 유지)"
else
  EXISTING_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  put_param "$SSM_PREFIX/ORIGIN_SECRET" "$EXISTING_SECRET" "오리진 비밀 (신규 생성)"
fi
# 03-cloudfront.sh 가 CloudFront 커스텀 헤더로 넣기 위해 상태에 저장
state_set ORIGIN_SECRET "$EXISTING_SECRET"

# ────────────────────────────────────────────────────────────
step "IAM 정책 — 최소 권한"
# ────────────────────────────────────────────────────────────
# 리전을 * 로 둔 이유:
#  - Bedrock 교차 리전 추론 프로필(us./apac./global.)은 요청이 다른 리전으로 라우팅됩니다
#  - Lambda를 다른 리전에 만들었을 때 조용히 권한 거부되는 함정을 막습니다
#  계정 ID + 리소스 이름으로는 여전히 좁혀져 있습니다
POLICY_DOC="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:$ACCOUNT_ID:inference-profile/*",
        "arn:aws:bedrock:*:$ACCOUNT_ID:application-inference-profile/*"
      ]
    },
    {
      "Sid": "DynamoDBSingleTable",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:*:$ACCOUNT_ID:table/$TABLE_NAME"
    },
    {
      "Sid": "ReadApiKeysFromSSM",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
      "Resource": [
        "arn:aws:ssm:*:$ACCOUNT_ID:parameter${SSM_PREFIX}",
        "arn:aws:ssm:*:$ACCOUNT_ID:parameter${SSM_PREFIX}/*"
      ]
    },
    {
      "Sid": "DecryptSecureString",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": { "StringLike": { "kms:ViaService": "ssm.*.amazonaws.com" } }
    }
  ]
}
JSON
)"

POLICY_ARN="$(policy_arn)"
if policy_exists; then
  # 기존 정책에 새 버전 생성 (버전이 5개면 가장 오래된 비기본 버전 삭제)
  VERSIONS="$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text)"
  COUNT="$(printf '%s' "$VERSIONS" | wc -w | tr -d ' ')"
  if [ "$COUNT" -ge 4 ]; then
    OLDEST="$(printf '%s' "$VERSIONS" | tr '\t' '\n' | tail -1)"
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLDEST" >/dev/null 2>&1 || true
  fi
  aws iam create-policy-version \
    --policy-arn "$POLICY_ARN" \
    --policy-document "$POLICY_DOC" \
    --set-as-default >/dev/null && ok "정책 $POLICY_NAME 갱신" || warn "정책 갱신 실패 (기존 버전 유지)"
else
  aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document "$POLICY_DOC" \
    --description "BookBot Lambda: Bedrock + DynamoDB + SSM" \
    >/dev/null || die "정책 생성 실패"
  ok "정책 $POLICY_NAME 생성"
fi

# ────────────────────────────────────────────────────────────
step "IAM 실행 역할"
# ────────────────────────────────────────────────────────────
TRUST_DOC='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'

if role_exists; then
  skip "역할 $ROLE_NAME"
else
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_DOC" \
    --description "BookBot Lambda execution role" \
    >/dev/null || die "역할 생성 실패"
  ok "역할 $ROLE_NAME 생성"
fi

for arn in "$POLICY_ARN" "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"; do
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$arn" >/dev/null 2>&1
done
ok "정책 연결: $POLICY_NAME + AWSLambdaBasicExecutionRole"

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"
state_set ROLE_ARN "$ROLE_ARN"

# ────────────────────────────────────────────────────────────
step "Lambda 패키징"
# ────────────────────────────────────────────────────────────
( cd "$BACKEND_DIR" && bash scripts/build.sh >/dev/null 2>&1 ) || die "빌드 실패 — cd backend && bash scripts/build.sh 로 확인하세요"
ZIP="$BACKEND_DIR/dist/bookbot-backend.zip"
[ -f "$ZIP" ] || die "zip이 생성되지 않았습니다"
ok "zip 생성 ($(du -h "$ZIP" | cut -f1))"

# ────────────────────────────────────────────────────────────
step "Lambda 함수"
# ────────────────────────────────────────────────────────────
# ★ 기존 Lambda 환경 변수를 보존합니다.
#
#   이 스크립트는 환경 변수 맵을 **통째로 교체**합니다. 그런데 배포 번들에는
#   secrets.env 가 (API 키 보호를 위해) 의도적으로 제외되어 있습니다.
#   그래서 폴더를 새 번들로 교체한 뒤 이 스크립트를 돌리면 secrets.env 가 없어
#   BEDROCK_MODEL_ID 가 빈 값으로 덮어써지고 채팅이 죽습니다.
#   실제로 이 사고가 두 번 났습니다.
#
#   → secrets.env 에 값이 없으면 현재 Lambda에 설정된 값을 그대로 유지합니다.
if [ -z "${BEDROCK_MODEL_ID:-}" ] && lambda_exists; then
  EXISTING_MODEL="$(aws lambda get-function-configuration --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --query 'Environment.Variables.BEDROCK_MODEL_ID' --output text 2>/dev/null || true)"
  if [ -n "$EXISTING_MODEL" ] && [ "$EXISTING_MODEL" != "None" ]; then
    BEDROCK_MODEL_ID="$EXISTING_MODEL"
    warn "secrets.env에 BEDROCK_MODEL_ID가 없어 기존 Lambda 값을 유지합니다: $EXISTING_MODEL"
  fi
fi

if [ -z "${BEDROCK_MODEL_ID:-}" ]; then
  fail "BEDROCK_MODEL_ID를 결정할 수 없습니다"
  cat <<EOF

  빈 값으로 배포하면 채팅이 반드시 실패하므로 여기서 중단합니다.

  ${C_BLD}해결${C_RST}
    cat > infra/secrets.env <<'ENVEOF'
    BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6
    GOOGLE_BOOKS_API_KEY=
    HARDCOVER_TOKEN=
    ALERT_EMAIL=
    CONTACT_EMAIL=
    ENVEOF

  사용 가능한 모델 확인:
    bash infra/select-model.sh

  ${C_DIM}※ 도서 API 키는 비워두세요. 이미 SSM에 있으면 그대로 유지됩니다.${C_RST}

EOF
  exit 1
fi
ok "모델 ID $BEDROCK_MODEL_ID"

# ★ 핸들러를 API 오리진 방식에 맞춰 결정합니다.
#
#   이 스크립트는 원래 Lambda Function URL 전용이라 핸들러를
#   항상 src/index.handler (스트리밍)로 설정했습니다.
#   그런데 이 계정은 Lambda Public Access Block 때문에 함수 URL을 쓸 수 없어
#   API Gateway로 전환했고, API Gateway는 버퍼 응답이 필요합니다.
#
#   그 상태에서 이 스크립트를 돌리면 핸들러가 스트리밍으로 되돌아가고,
#   API Gateway 환경에는 globalThis.awslambda 가 없어 즉시 TypeError →
#   "Internal Server Error" 가 됩니다. 실제로 이 사고가 발생했습니다.
#
#   → API Gateway가 존재하면 bufferedHandler 를 씁니다.
APIGW_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${PROJECT}-http-api'].ApiId | [0]" --output text 2>/dev/null || true)"

if [ -n "$APIGW_ID" ] && [ "$APIGW_ID" != "None" ]; then
  LAMBDA_HANDLER="src/index.bufferedHandler"
  warn "API Gateway($APIGW_ID) 감지 — 핸들러를 버퍼 모드로 설정합니다"
  info "API Gateway는 응답 스트리밍을 쓰지 않으므로 bufferedHandler 가 필요합니다"
  # 30초 통합 타임아웃에 맞춰 도구 반복을 제한
  # 벤치마크 기간에는 낮추지 않습니다. 예산 차감(openai.mjs)이 들어가면서
  # 시간 초과는 예산으로 통제되고, 도구 반복은 추천 품질에 직결됩니다.
  if [ "${APIGW_CLAMP_TOOL_ITER:-0}" = "1" ] && [ "${MAX_TOOL_ITERATIONS:-4}" -gt 3 ]; then
    MAX_TOOL_ITERATIONS=3
    info "MAX_TOOL_ITERATIONS=3 (APIGW_CLAMP_TOOL_ITER=1)"
  fi
  # 반복 "횟수"만 줄여도 반복당 소요 시간은 통제되지 않습니다.
  # 외부 API가 느린 날 반복 2회로 30초를 넘겨 504가 났습니다.
  # 시간 예산을 함께 걸어서 초과 시 검색을 멈추고 답변을 마무리하게 합니다.
  AGENT_BUDGET_MS="${AGENT_BUDGET_MS:-18000}"
  info "AGENT_BUDGET_MS=$AGENT_BUDGET_MS (초과 시 검색 중단 후 답변 마무리)"
  # 요청 전체의 벽. 도구 라운드뿐 아니라 Bedrock 턴·보충 조회까지 감쌉니다.
  # 통합 타임아웃 30초는 증액할 수 없으므로(AWS 쿼터: Can be increased = No)
  # 응답 직렬화 여유 4초를 남깁니다.
  REQUEST_BUDGET_MS="${REQUEST_BUDGET_MS:-26000}"
  info "REQUEST_BUDGET_MS=$REQUEST_BUDGET_MS (통합 타임아웃 30초 - 여유 4초)"
else
  AGENT_BUDGET_MS="${AGENT_BUDGET_MS:-60000}"
  # 함수 URL 모드에는 API Gateway 벽이 없습니다. Lambda 타임아웃 90초가 상한이라
  # 전송 여유를 두고 80초까지 씁니다.
  REQUEST_BUDGET_MS="${REQUEST_BUDGET_MS:-80000}"
  info "함수 URL 모드 — 핸들러 $LAMBDA_HANDLER (스트리밍)"
  info "REQUEST_BUDGET_MS=$REQUEST_BUDGET_MS (Lambda 타임아웃 ${LAMBDA_TIMEOUT}초 - 여유)"
fi

ENV_VARS="Variables={\
POLICY_LLM_CHECK=${POLICY_LLM_CHECK:-1},\
POLICY_BLOCK_VALUE=${POLICY_BLOCK_VALUE:-BLOCK},\
POLICY_FAIL_CLOSED=${POLICY_FAIL_CLOSED:-0},\
CHAT_LOG_ENABLED=${CHAT_LOG_ENABLED:-1},\
CHAT_LOG_TTL_DAYS=${CHAT_LOG_TTL_DAYS:-90},\
CHAT_LOG_TZ_OFFSET_HOURS=${CHAT_LOG_TZ_OFFSET_HOURS:-9},\
CHAT_LOG_SAVE_IP=${CHAT_LOG_SAVE_IP:-0},\
BEDROCK_REGION=$BEDROCK_REGION,\
BEDROCK_MODEL_ID=${BEDROCK_MODEL_ID:-},\
BEDROCK_MAX_TOKENS=$BEDROCK_MAX_TOKENS,\
BEDROCK_TEMPERATURE=$BEDROCK_TEMPERATURE,\
TABLE_NAME=$TABLE_NAME,\
SSM_PREFIX=$SSM_PREFIX,\
RATE_LIMIT_PER_MINUTE=$RATE_LIMIT_PER_MINUTE,\
RATE_LIMIT_PER_DAY=$RATE_LIMIT_PER_DAY,\
OPENAI_RATE_LIMIT_PER_MINUTE=${OPENAI_RATE_LIMIT_PER_MINUTE:-10000},\
OPENAI_RATE_LIMIT_PER_DAY=${OPENAI_RATE_LIMIT_PER_DAY:-100000},\
OPENAI_BUDGET_MS=${OPENAI_BUDGET_MS:-12500},\
OPENAI_ANSWER_RESERVE_MS=${OPENAI_ANSWER_RESERVE_MS:-7500},\
MAX_TOOL_ITERATIONS=$MAX_TOOL_ITERATIONS,\
AGENT_BUDGET_MS=$AGENT_BUDGET_MS,\
REQUEST_BUDGET_MS=$REQUEST_BUDGET_MS,\
ANSWER_RESERVE_MS=${ANSWER_RESERVE_MS:-15000},\
MIN_CARDS=${MIN_CARDS:-12},\
EXTERNAL_API_TIMEOUT_MS=${EXTERNAL_API_TIMEOUT_MS:-5000},\
EXTERNAL_API_RETRIES=${EXTERNAL_API_RETRIES:-1},\
GUTENDEX_TIMEOUT_MS=4000,\
CONTACT_EMAIL=${CONTACT_EMAIL:-bookbot@example.com},\
LOG_LEVEL=info}"

if lambda_exists; then
  aws lambda update-function-code \
    --region "$REGION" --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP" >/dev/null || die "코드 업데이트 실패"
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
  ok "코드 업데이트"

  aws lambda update-function-configuration \
    --region "$REGION" --function-name "$FUNCTION_NAME" \
    --handler "$LAMBDA_HANDLER" \
    --runtime "$LAMBDA_RUNTIME" \
    --memory-size "$LAMBDA_MEMORY" \
    --timeout "$LAMBDA_TIMEOUT" \
    --role "$ROLE_ARN" \
    --environment "$ENV_VARS" >/dev/null || die "설정 업데이트 실패"
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
  ok "설정 업데이트 (핸들러/메모리/타임아웃/환경변수)"
else
  # 역할이 방금 만들어졌으면 전파에 시간이 걸립니다 → 재시도
  info "함수 생성 (IAM 역할 전파 대기 포함)..."
  CREATED=0
  for i in 1 2 3 4 5 6; do
    if aws lambda create-function \
        --region "$REGION" \
        --function-name "$FUNCTION_NAME" \
        --runtime "$LAMBDA_RUNTIME" \
        --architectures "$LAMBDA_ARCH" \
        --role "$ROLE_ARN" \
        --handler "$LAMBDA_HANDLER" \
        --zip-file "fileb://$ZIP" \
        --memory-size "$LAMBDA_MEMORY" \
        --timeout "$LAMBDA_TIMEOUT" \
        --environment "$ENV_VARS" \
        --tags "Project=$PROJECT" \
        >/dev/null 2>"$INFRA_DIR/.lambda-err"; then
      CREATED=1; break
    fi
    if grep -q "cannot be assumed" "$INFRA_DIR/.lambda-err" 2>/dev/null; then
      info "  역할 전파 대기 중... ($i/6)"; sleep 8
    else
      sed 's/^/      /' "$INFRA_DIR/.lambda-err"; break
    fi
  done
  rm -f "$INFRA_DIR/.lambda-err"
  [ $CREATED -eq 1 ] || die "함수 생성 실패"
  aws lambda wait function-active --function-name "$FUNCTION_NAME" --region "$REGION"
  ok "함수 $FUNCTION_NAME 생성 ($LAMBDA_RUNTIME / $LAMBDA_ARCH)"
fi

# ── 예약 동시성 — 비용 폭탄 3차 방어선 ─────────────────────
#
# AWS는 계정의 "미예약 동시성"이 항상 10 이상 남아 있어야 한다고 요구합니다.
# 교육/신규 계정은 계정 동시성 한도가 10~50으로 낮은 경우가 많아,
# 10을 예약하려 하면 InvalidParameterValueException이 납니다.
# 그런 경우엔 계정 한도 자체가 상한 역할을 하므로 방어는 유지됩니다.
#
# LAMBDA_RESERVED_CONCURRENCY=none 이면 예약을 삭제합니다.
#
#   왜 이런 선택지가 필요한가 — 예약 동시성은 **동시 실행 상한**이라, 값이 10이면
#   11번째 동시 요청부터 Lambda 가 시작조차 못 하고 API Gateway 가 503 을 줍니다.
#   GuardBench 는 TestCase 를 병렬로 던지므로 41건 실행에서 실측 25건이 503 이었고,
#   GuardBench 쪽에서는 PROVIDER_UNAVAILABLE 로 기록되어 재시도 3회를 모두 소진했습니다.
if [ "$LAMBDA_RESERVED_CONCURRENCY" = "none" ]; then
  if aws lambda delete-function-concurrency \
      --region "$REGION" --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
    ok "예약 동시성 삭제 — 계정 미예약 풀을 함께 사용합니다"
  else
    info "예약 동시성이 이미 없습니다"
  fi
  warn "동시 실행 상한이 계정 한도까지 열렸습니다 (공개 엔드포인트 + Bedrock)"
  info "남은 방어: 앱 레이트리밋(IP별) · WAF 5분당 300 · Budgets \$100 / Bedrock \$50"
  info "벤치마크가 끝나면 LAMBDA_RESERVED_CONCURRENCY=10 으로 되돌리세요"
else
ACCOUNT_LIMIT="$(aws lambda get-account-settings --region "$REGION" \
  --query 'AccountLimit.ConcurrentExecutions' --output text 2>/dev/null || echo "")"

if [ -n "$ACCOUNT_LIMIT" ] && [ "$ACCOUNT_LIMIT" != "None" ]; then
  MAX_RESERVABLE=$(( ACCOUNT_LIMIT - 10 ))
  if [ "$MAX_RESERVABLE" -lt 1 ]; then
    warn "예약 동시성을 설정할 수 없습니다 (계정 한도 $ACCOUNT_LIMIT, 미예약분 최소 10 필요)"
    info "계정 동시성 한도 $ACCOUNT_LIMIT 자체가 상한 역할을 합니다 — 비용 방어는 유지됩니다"
    info "다른 방어층(앱 레이트리밋 / WAF / 예산 알림)이 그대로 동작합니다"
  else
    TARGET="$LAMBDA_RESERVED_CONCURRENCY"
    [ "$TARGET" -gt "$MAX_RESERVABLE" ] && TARGET="$MAX_RESERVABLE"
    if aws lambda put-function-concurrency \
        --region "$REGION" --function-name "$FUNCTION_NAME" \
        --reserved-concurrent-executions "$TARGET" >/dev/null 2>&1; then
      ok "예약 동시성 $TARGET (계정 한도 $ACCOUNT_LIMIT)"
    else
      warn "예약 동시성 설정 실패 — 계정 한도 $ACCOUNT_LIMIT 가 상한 역할을 합니다"
    fi
  fi
else
  warn "계정 동시성 한도를 조회할 수 없어 예약 동시성을 건너뜁니다"
fi
fi

# ── 로그 보존 기간 — 안 하면 무기한 쌓입니다 ────────────────
aws logs put-retention-policy \
  --region "$REGION" \
  --log-group-name "/aws/lambda/$FUNCTION_NAME" \
  --retention-in-days 14 >/dev/null 2>&1 \
  && ok "로그 보존 14일" \
  || info "로그 그룹은 첫 실행 후 생성됩니다"

# ────────────────────────────────────────────────────────────
step "Function URL — 스트리밍 + IAM 인증"
# ────────────────────────────────────────────────────────────
# 인증 유형이 NONE인 이유는 위 "오리진 비밀" 주석 참고.
# 대신 앱 레벨에서 x-origin-secret 헤더를 검증합니다.
if FURL="$(aws lambda get-function-url-config \
    --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query FunctionUrl --output text 2>/dev/null)"; then
  aws lambda update-function-url-config \
    --region "$REGION" --function-name "$FUNCTION_NAME" \
    --auth-type NONE --invoke-mode RESPONSE_STREAM >/dev/null
  ok "Function URL 갱신 (NONE / RESPONSE_STREAM)"
else
  # ★ 여기서 die 하면 안 됩니다.
  #   이 계정은 Lambda Public Access Block 때문에 함수 URL 생성이 거부될 수 있고,
  #   그러면 위에서 코드·설정은 이미 올라간 상태로 스크립트가 죽습니다.
  #   update.sh 는 그 실패를 받아 프론트엔드 배포를 건너뛰므로,
  #   백엔드만 새 코드인 어긋난 상태가 됩니다.
  #   API Gateway 모드에서는 함수 URL이 아예 필요 없습니다.
  if FURL="$(aws lambda create-function-url-config \
      --region "$REGION" --function-name "$FUNCTION_NAME" \
      --auth-type NONE --invoke-mode RESPONSE_STREAM \
      --query FunctionUrl --output text 2>"$INFRA_DIR/.furl-err")"; then
    ok "Function URL 생성 (NONE / RESPONSE_STREAM)"
  else
    FURL=""
    if [ -n "$APIGW_ID" ] && [ "$APIGW_ID" != "None" ]; then
      skip "Function URL (API Gateway 모드에서는 불필요)"
    else
      fail "Function URL 생성 실패 — API 오리진이 없습니다. AWS 원문:"
      sed 's/^/      /' "$INFRA_DIR/.furl-err" | head -3
      info "bash infra/05-apigateway.sh 로 API Gateway 를 만드세요"
    fi
  fi
  rm -f "$INFRA_DIR/.furl-err"
fi

# 인증 유형을 NONE으로 바꾸면 함수 URL 호출에 lambda:InvokeFunctionUrl 권한이
# 필요합니다(Principal *). 이게 없으면 CloudFront도 403을 받습니다.
aws lambda add-permission \
  --region "$REGION" --function-name "$FUNCTION_NAME" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal '*' \
  --function-url-auth-type NONE >/dev/null 2>&1 \
  && ok "함수 URL 호출 권한 추가" \
  || info "함수 URL 호출 권한 이미 존재"

# OAC 시절의 CloudFront 전용 정책문은 더 이상 필요 없습니다 (있으면 제거)
aws lambda remove-permission --region "$REGION" --function-name "$FUNCTION_NAME" \
  --statement-id AllowCloudFrontServicePrincipal >/dev/null 2>&1 \
  && info "구 OAC 정책문 제거" || true

if [ -n "$FURL" ]; then
  FURL_HOST="$(printf '%s' "$FURL" | sed -E 's#^https?://##; s#/+$##')"
  state_set FUNCTION_URL "$FURL"
  state_set FUNCTION_URL_HOST "$FURL_HOST"
  info "URL : $FURL"
  info "호스트: $FURL_HOST"
  warn "인증 유형 NONE — 대신 Lambda가 x-origin-secret 헤더를 검증합니다."
  info "헤더 없이 직접 호출하면 403 Forbidden 이 반환됩니다 (CloudFront 경유만 통과)."
fi

# ────────────────────────────────────────────────────────────
step "헬스체크 (Lambda 직접 호출)"
# ────────────────────────────────────────────────────────────
PAYLOAD="$(python3 -c 'import json;print(json.dumps({
  "version":"2.0","rawPath":"/api/health",
  "requestContext":{"http":{"method":"GET","sourceIp":"127.0.0.1"}},
  "headers":{},"isBase64Encoded":False}))')"

if aws lambda invoke \
    --region "$REGION" --function-name "$FUNCTION_NAME" \
    --cli-binary-format raw-in-base64-out \
    --payload "$PAYLOAD" \
    "$INFRA_DIR/.health.json" >/dev/null 2>&1; then

  # 스트리밍 응답은 프리앰블 + NUL + 본문 형태 → 마지막 JSON 객체만 추출
  python3 - "$INFRA_DIR/.health.json" <<'PY'
import json, re, sys
raw = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace')
raw = raw.replace('\x00', '')
# 마지막 최상위 JSON 객체 찾기
objs, depth, start = [], 0, None
for i, ch in enumerate(raw):
    if ch == '{':
        if depth == 0: start = i
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0 and start is not None:
            objs.append(raw[start:i+1]); start = None
body = None
for o in reversed(objs):
    try:
        d = json.loads(o)
        if 'ok' in d: body = d; break
    except Exception: pass
if not body:
    print('  ! 헬스체크 응답을 파싱할 수 없습니다:'); print('   ', raw[:400]); sys.exit(0)

g = '\033[32m'; r = '\033[31m'; y = '\033[33m'; d0 = '\033[2m'; x = '\033[0m'
print(f"  {'✓' if body.get('ok') else '✗'} ok = {body.get('ok')}")
reg = body.get('regions', {})
print(f"  {d0}리전   lambda={reg.get('lambda')} dynamodb={reg.get('dynamodb')} ssm={reg.get('ssm')} bedrock={reg.get('bedrock')}{x}")
bd = body.get('bedrock', {})
print(f"  {d0}모델   {bd.get('modelId')}  (형식 유효: {bd.get('modelIdLooksValid')}){x}")
dy = body.get('dynamodb', {})
print(f"  {d0}DDB    ok={dy.get('ok')} table={dy.get('table')} {dy.get('latencyMs','')}ms{x}")
se = body.get('secrets', {})
print(f"  {d0}키     GoogleBooks={se.get('GOOGLE_BOOKS_API_KEY')} Hardcover={se.get('HARDCOVER_TOKEN')}{x}")
probs = body.get('problems') or []
if probs:
    print(f"\n  {y}해결해야 할 항목:{x}")
    for i, p in enumerate(probs, 1):
        print(f"    {i}. {p}")
else:
    print(f"\n  {g}설정 문제 없음{x}")
PY
  rm -f "$INFRA_DIR/.health.json"
else
  warn "Lambda 직접 호출 실패 — CloudWatch 로그를 확인하세요"
fi

printf '\n'
ok "백엔드 완료"
