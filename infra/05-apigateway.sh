#!/usr/bin/env bash
#
# API Gateway HTTP API 전환 — Lambda 함수 URL 대안
#
#   bash infra/05-apigateway.sh
#
# ══════════════════════════════════════════════════════════════
# 왜 이 스크립트가 필요한가 (배경)
# ══════════════════════════════════════════════════════════════
# 원래는 Lambda Function URL을 CloudFront 오리진으로 썼습니다. 그런데 두 갈래가
# 모두 막히는 상황이 실제로 발생했습니다.
#
#   ① 함수 URL + AuthType=AWS_IAM + CloudFront OAC
#      → AWS 문서 명시 제약: "If you use PUT or POST methods with your Lambda
#        function URL, your users must compute the SHA256 of the body and include
#        the payload hash value in the x-amz-content-sha256 header. Lambda doesn't
#        support unsigned payloads."
#      → 즉 브라우저가 본문 해시 + SigV4 서명을 해야 함. 공개 웹앱에서 불가능.
#      → GET /api/health 는 통과, POST /api/chat 은 403.
#
#   ② 함수 URL + AuthType=NONE + 오리진 비밀 헤더
#      → Lambda "Public Access Block"(RestrictPublicResource=true)이 계정/조직
#        수준에서 켜져 있으면, 리소스 정책이 Principal:* 를 허용해도 403.
#      → 교육/기업 관리 계정에서 흔한 가드레일이라 사용자가 끌 수 없습니다.
#
# API Gateway는 이 문제를 우회합니다.
#   - 클라이언트는 익명으로 호출 (인증자 없음) → "공개 리소스 정책" 무관
#   - Lambda 호출은 서비스 주체(apigateway.amazonaws.com)로 이루어짐
#     → Public Access Block과 충돌하지 않습니다
#   - POST 본문 서명 문제 없음
#   - 스테이지 스로틀링을 무료로 얻습니다
#
# 트레이드오프
#   - HTTP API 통합 타임아웃 상한이 30초입니다 (함수 URL은 15분).
#     그래서 MAX_TOOL_ITERATIONS 를 3으로 낮춥니다.
#   - 응답 스트리밍 설정이 함수 URL보다 번거롭습니다. 기본은 버퍼 모드로 갑니다
#     (핸들러를 src/index.bufferedHandler 로 전환). 타이핑 효과만 사라지고
#     책 카드·도구 표시·세션은 그대로 동작합니다 (프론트가 두 형식을 모두 처리).
# ══════════════════════════════════════════════════════════════
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "API Gateway HTTP API 전환"

require_cli
require_creds
state_load

API_NAME="${PROJECT}-http-api"
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

# HTTP API 통합 타임아웃 상한(30초)에 맞춰 도구 반복을 줄입니다
APIGW_TIMEOUT_MS="${APIGW_TIMEOUT_MS:-30000}"
TOOL_ITER_FOR_APIGW="${TOOL_ITER_FOR_APIGW:-3}"

lambda_exists || die "Lambda 함수 $FUNCTION_NAME 이 없습니다. 먼저 bash infra/01-backend.sh 를 실행하세요."

# ────────────────────────────────────────────────────────────
step "오리진 비밀 확보"
# ────────────────────────────────────────────────────────────
ORIGIN_SECRET="$(state_get ORIGIN_SECRET)"
if [ -z "$ORIGIN_SECRET" ]; then
  ORIGIN_SECRET="$(aws ssm get-parameter --region "$REGION" \
    --name "$SSM_PREFIX/ORIGIN_SECRET" --with-decryption \
    --query 'Parameter.Value' --output text 2>/dev/null || true)"
fi
if [ -z "$ORIGIN_SECRET" ]; then
  ORIGIN_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  aws ssm put-parameter --region "$REGION" \
    --name "$SSM_PREFIX/ORIGIN_SECRET" --value "$ORIGIN_SECRET" \
    --type SecureString --key-id alias/aws/ssm --overwrite >/dev/null
  ok "오리진 비밀 신규 생성"
else
  ok "오리진 비밀 확보 (${#ORIGIN_SECRET}자)"
fi
state_set ORIGIN_SECRET "$ORIGIN_SECRET"

# ────────────────────────────────────────────────────────────
step "Lambda 핸들러를 버퍼 모드로 전환"
# ────────────────────────────────────────────────────────────
# API Gateway 기본 통합은 버퍼 응답입니다. 스트리밍 핸들러를 그대로 쓰면
# awslambda 전역이 없어 실패하므로 bufferedHandler 로 바꿉니다.
aws lambda update-function-configuration \
  --region "$REGION" --function-name "$FUNCTION_NAME" \
  --handler "src/index.bufferedHandler" >/dev/null || die "핸들러 변경 실패"
aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
ok "핸들러 src/index.bufferedHandler"

# 30초 상한에 맞춰 도구 반복 축소
CUR_ENV="$(aws lambda get-function-configuration --region "$REGION" \
  --function-name "$FUNCTION_NAME" --query 'Environment.Variables' --output json)"
NEW_ENV="$(printf '%s' "$CUR_ENV" | python3 -c "
import json, sys
v = json.load(sys.stdin) or {}
v['MAX_TOOL_ITERATIONS'] = '$TOOL_ITER_FOR_APIGW'
print(json.dumps({'Variables': v}))
")"
aws lambda update-function-configuration \
  --region "$REGION" --function-name "$FUNCTION_NAME" \
  --environment "$NEW_ENV" >/dev/null || warn "환경 변수 갱신 실패"
aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
ok "MAX_TOOL_ITERATIONS=$TOOL_ITER_FOR_APIGW (통합 타임아웃 ${APIGW_TIMEOUT_MS}ms 대응)"

# ────────────────────────────────────────────────────────────
step "HTTP API 생성"
# ────────────────────────────────────────────────────────────
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text 2>/dev/null || true)"

if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  skip "API $API_NAME ($API_ID)"
else
  API_ID="$(aws apigatewayv2 create-api \
    --region "$REGION" \
    --name "$API_NAME" \
    --protocol-type HTTP \
    --description "BookBot chat API (fronted by CloudFront)" \
    --query ApiId --output text)" || die "API 생성 실패"
  ok "API 생성 $API_ID"
fi
state_set API_ID "$API_ID"

# ────────────────────────────────────────────────────────────
step "Lambda 프록시 통합"
# ────────────────────────────────────────────────────────────
INTEG_ID="$(aws apigatewayv2 get-integrations --region "$REGION" --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$LAMBDA_ARN'].IntegrationId | [0]" --output text 2>/dev/null || true)"

if [ -n "$INTEG_ID" ] && [ "$INTEG_ID" != "None" ]; then
  aws apigatewayv2 update-integration --region "$REGION" --api-id "$API_ID" \
    --integration-id "$INTEG_ID" \
    --timeout-in-millis "$APIGW_TIMEOUT_MS" >/dev/null 2>&1
  skip "통합 $INTEG_ID"
else
  INTEG_ID="$(aws apigatewayv2 create-integration \
    --region "$REGION" --api-id "$API_ID" \
    --integration-type AWS_PROXY \
    --integration-uri "$LAMBDA_ARN" \
    --payload-format-version 2.0 \
    --timeout-in-millis "$APIGW_TIMEOUT_MS" \
    --query IntegrationId --output text)" || die "통합 생성 실패"
  ok "통합 생성 $INTEG_ID (payload 2.0, 타임아웃 ${APIGW_TIMEOUT_MS}ms)"
fi

# ────────────────────────────────────────────────────────────
step "라우트"
# ────────────────────────────────────────────────────────────
# payload 2.0 이벤트는 rawPath / requestContext.http.method / body 를 담습니다.
# backend/src/index.mjs 의 parseRequest 가 이 형식을 그대로 처리합니다.
for RK in 'ANY /api/{proxy+}' 'ANY /api'; do
  EXISTING="$(aws apigatewayv2 get-routes --region "$REGION" --api-id "$API_ID" \
    --query "Items[?RouteKey=='$RK'].RouteId | [0]" --output text 2>/dev/null || true)"
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
    skip "라우트 $RK"
  else
    aws apigatewayv2 create-route --region "$REGION" --api-id "$API_ID" \
      --route-key "$RK" --target "integrations/$INTEG_ID" >/dev/null 2>&1 \
      && ok "라우트 $RK" || warn "라우트 $RK 생성 실패"
  fi
done

# ────────────────────────────────────────────────────────────
step "스테이지 (\$default, 자동 배포) + 스로틀링"
# ────────────────────────────────────────────────────────────
# $default 스테이지는 URL에 스테이지 이름이 붙지 않습니다.
# → https://{api-id}.execute-api.{region}.amazonaws.com/api/chat
if aws apigatewayv2 get-stage --region "$REGION" --api-id "$API_ID" \
     --stage-name '$default' >/dev/null 2>&1; then
  aws apigatewayv2 update-stage --region "$REGION" --api-id "$API_ID" \
    --stage-name '$default' --auto-deploy \
    --default-route-settings 'ThrottlingBurstLimit=20,ThrottlingRateLimit=10' >/dev/null
  skip "스테이지 \$default (스로틀링 갱신)"
else
  aws apigatewayv2 create-stage --region "$REGION" --api-id "$API_ID" \
    --stage-name '$default' --auto-deploy \
    --default-route-settings 'ThrottlingBurstLimit=20,ThrottlingRateLimit=10' >/dev/null \
    || die "스테이지 생성 실패"
  ok "스테이지 \$default 생성"
fi
ok "스로틀링: 초당 10 요청 / 버스트 20 (비용 방어 추가 층)"

# ────────────────────────────────────────────────────────────
step "Lambda 호출 권한 (API Gateway 서비스 주체)"
# ────────────────────────────────────────────────────────────
# 서비스 주체 허용이므로 Public Access Block(RestrictPublicResource)과 충돌하지 않습니다.
aws lambda remove-permission --region "$REGION" --function-name "$FUNCTION_NAME" \
  --statement-id AllowApiGatewayInvoke >/dev/null 2>&1 || true

aws lambda add-permission \
  --region "$REGION" --function-name "$FUNCTION_NAME" \
  --statement-id AllowApiGatewayInvoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" \
  >/dev/null && ok "lambda:InvokeFunction 허용 (SourceArn: 이 API만)" \
  || die "Lambda 권한 추가 실패"

# ────────────────────────────────────────────────────────────
step "엔드포인트 확인"
# ────────────────────────────────────────────────────────────
API_ENDPOINT="$(aws apigatewayv2 get-api --region "$REGION" --api-id "$API_ID" \
  --query ApiEndpoint --output text)"
API_HOST="$(printf '%s' "$API_ENDPOINT" | sed -E 's#^https?://##; s#/+$##')"
state_set API_ENDPOINT "$API_ENDPOINT"
state_set API_GW_HOST "$API_HOST"
ok "엔드포인트 $API_ENDPOINT"

info "직접 호출 테스트 (비밀 헤더 없이 → /api/health 는 통과해야 함)"
sleep 5
CODE="$(curl -s -o "$INFRA_DIR/.apitest" -w '%{http_code}' -m 30 "$API_ENDPOINT/api/health" || echo 000)"
if [ "$CODE" = "200" ]; then
  ok "HTTP 200 — API Gateway → Lambda 경로 정상"
  python3 -c "
import json
d = json.load(open('$INFRA_DIR/.apitest'))
print('    모델 :', d.get('bedrock',{}).get('modelId'))
print('    DDB  :', d.get('dynamodb',{}).get('ok'))
print('    키   :', d.get('secrets',{}).get('GOOGLE_BOOKS_API_KEY'), d.get('secrets',{}).get('HARDCOVER_TOKEN'))
for i, p in enumerate(d.get('problems') or [], 1):
    print(f'    ! {i}. {p}')
" 2>/dev/null || head -c 300 "$INFRA_DIR/.apitest"
else
  fail "HTTP $CODE"
  head -c 400 "$INFRA_DIR/.apitest" 2>/dev/null; echo
fi
rm -f "$INFRA_DIR/.apitest"

# ────────────────────────────────────────────────────────────
printf '\n'
ok "API Gateway 전환 완료"
cat <<EOF

  ${C_BLD}다음 단계${C_RST}
    CloudFront 오리진을 API Gateway로 바꿉니다:
      ${C_BLD}bash infra/03-cloudfront.sh${C_RST}
    (.state의 API_GW_HOST를 자동으로 감지해서 사용합니다)

  ${C_DIM}함수 URL은 더 이상 쓰지 않습니다. 공격 표면을 줄이려면 삭제하세요:
    aws lambda delete-function-url-config --function-name $FUNCTION_NAME --region $REGION${C_RST}

EOF
