#!/usr/bin/env bash
#
#   bash infra/doctor.sh
#
# 명령 하나로 전부 처리합니다.
#
#   1) AWS에서 현재 리소스 상태를 직접 발견 (.state 없어도 동작 — 스스로 복원)
#   2) 잘못된 설정을 자동 수정 (핸들러 / 모델ID / 환경변수 / 권한 / 오리진)
#   3) CloudFront 전파 대기
#   4) 실제 사이트를 端到端 검증 (프론트 / 헬스 / 채팅 / 보안 / 레이트리밋)
#   5) 한 장 보고서 출력
#
# 몇 번을 다시 실행해도 안전합니다(idempotent).
#
# 옵션:
#   NO_WAIT=1     전파 대기 생략
#   NO_FIX=1      진단만, 수정하지 않음
#   QUICK=1       레이트리밋 테스트 생략(빠름)
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

REPORT="$INFRA_DIR/.doctor-report"
: > "$REPORT"
FIXES="$INFRA_DIR/.doctor-fixes"
: > "$FIXES"

PASS=0; FAILED=0; FIXED=0

rec()   { printf '%s|%s|%s\n' "$1" "$2" "${3:-}" >> "$REPORT"; }
p_ok()  { ok "$1";   PASS=$((PASS+1));     rec PASS "$1" "${2:-}"; }
p_bad() { fail "$1"; FAILED=$((FAILED+1)); rec FAIL "$1" "${2:-}"; }
p_fix() { printf '  %s✚%s %s\n' "$C_GRN" "$C_RST" "$1"; FIXED=$((FIXED+1))
          rec FIXED "$1" "${2:-}"; printf '%s\n' "$1" >> "$FIXES"; }

can_fix() { [ "${NO_FIX:-0}" != "1" ]; }

printf '%s' "$C_BLD"
cat <<'BANNER'
 ____              _    ____        _
| __ )  ___   ___ | | _| __ )  ___ | |_   doctor
|  _ \ / _ \ / _ \| |/ /  _ \ / _ \| __|
| |_) | (_) | (_) |   <| |_) | (_) | |_
|____/ \___/ \___/|_|\_\____/ \___/ \__|
BANNER
printf '%s\n' "$C_RST"

require_cli
require_creds
load_secrets
info "계정 $ACCOUNT_ID  리전 $REGION  주체 ${CALLER_ARN##*/}"

# ════════════════════════════════════════════════════════════
header "1. 리소스 발견"
# ════════════════════════════════════════════════════════════
# .state 를 신뢰하지 않고 AWS에서 직접 찾습니다. 파일이 없거나 깨져도 동작합니다.

step "Lambda"
if lambda_exists; then
  LCFG="$(aws lambda get-function-configuration --region "$REGION" \
    --function-name "$FUNCTION_NAME" --output json)"
  L_HANDLER="$(printf '%s' "$LCFG" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("Handler",""))')"
  L_TIMEOUT="$(printf '%s' "$LCFG" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("Timeout",0))')"
  L_MEM="$(printf '%s' "$LCFG" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("MemorySize",0))')"
  L_MODEL="$(printf '%s' "$LCFG" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Environment") or {}).get("Variables",{}).get("BEDROCK_MODEL_ID",""))')"
  p_ok "함수 $FUNCTION_NAME" "handler=$L_HANDLER mem=$L_MEM timeout=$L_TIMEOUT"
  info "핸들러 $L_HANDLER / 메모리 ${L_MEM}MB / 타임아웃 ${L_TIMEOUT}s"
  info "모델   ${L_MODEL:-(비어 있음)}"
else
  p_bad "Lambda 함수 $FUNCTION_NAME 없음" "bash infra/01-backend.sh 를 먼저 실행하세요"
  header "중단"; exit 1
fi

step "DynamoDB"
if ddb_table_exists; then
  T_TTL="$(aws dynamodb describe-time-to-live --region "$REGION" --table-name "$TABLE_NAME" \
    --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || echo NONE)"
  p_ok "테이블 $TABLE_NAME (TTL $T_TTL)"
  [ "$T_TTL" = "ENABLED" ] || warn "TTL이 켜져 있지 않습니다 — 데이터가 자동 삭제되지 않습니다"
else
  p_bad "DynamoDB 테이블 $TABLE_NAME 없음"
fi

step "SSM 파라미터"
SSM_NAMES="$(aws ssm get-parameters-by-path --region "$REGION" --path "$SSM_PREFIX" \
  --recursive --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' ' ' || true)"
for k in GOOGLE_BOOKS_API_KEY HARDCOVER_TOKEN ALADIN_TTB_KEY ORIGIN_SECRET; do
  case " $SSM_NAMES " in
    *"$SSM_PREFIX/$k"*) p_ok "$k 존재" ;;
    *) if [ "$k" = "ORIGIN_SECRET" ] && can_fix; then
         NEW="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
         aws ssm put-parameter --region "$REGION" --name "$SSM_PREFIX/$k" \
           --value "$NEW" --type SecureString --key-id alias/aws/ssm --overwrite >/dev/null \
           && p_fix "$k 생성" || p_bad "$k 생성 실패"
       elif [ "$k" = "ORIGIN_SECRET" ]; then
         p_bad "$k 없음" "함수 URL 직접 호출이 차단되지 않습니다"
       else
         # 도서 API 키는 없어도 서비스가 돕니다 — 품질만 떨어집니다.
         # 고장(p_bad)으로 세면 "배포 실패"로 오해하게 되므로 경고로 둡니다.
         case "$k" in
           ALADIN_TTB_KEY) warn "$k 없음 — 한국어 도서 결과가 빈약해집니다" ;;
           HARDCOVER_TOKEN) warn "$k 없음 — 무드·평점·내용주의가 전부 사라집니다" ;;
           *) warn "$k 없음 — 추천 품질이 떨어집니다" ;;
         esac
         info "발급 방법: docs/03-external-apis.md"
       fi ;;
  esac
done
ORIGIN_SECRET="$(aws ssm get-parameter --region "$REGION" --name "$SSM_PREFIX/ORIGIN_SECRET" \
  --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || true)"

step "API Gateway"
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${PROJECT}-http-api'].ApiId | [0]" --output text 2>/dev/null || true)"
if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  API_ENDPOINT="$(aws apigatewayv2 get-api --region "$REGION" --api-id "$API_ID" \
    --query ApiEndpoint --output text)"
  API_HOST="${API_ENDPOINT#https://}"
  MODE="apigateway"
  p_ok "HTTP API $API_ID" "$API_HOST"
else
  API_HOST=""; MODE="lambda-url"
  FURL="$(aws lambda get-function-url-config --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query FunctionUrl --output text 2>/dev/null || true)"
  if [ -n "$FURL" ] && [ "$FURL" != "None" ]; then
    API_HOST="$(printf '%s' "$FURL" | sed -E 's#^https?://##; s#/+$##')"
    warn "API Gateway 없음 — 함수 URL 사용 중 ($API_HOST)"
    warn "POST가 403이면 bash infra/05-apigateway.sh 로 전환하세요"
  else
    p_bad "API 오리진이 없습니다" "bash infra/05-apigateway.sh 를 실행하세요"
  fi
fi
info "모드: $MODE"

step "S3 / CloudFront"
DIST_ID=""; DIST_DOMAIN=""
DISTS="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Comment,'BookBot')].[Id,DomainName,Status,Enabled]" \
  --output text 2>/dev/null || true)"
DCOUNT="$(printf '%s\n' "$DISTS" | sed '/^$/d' | wc -l | tr -d ' ')"
if [ "$DCOUNT" = "0" ]; then
  p_bad "CloudFront 배포 없음" "bash infra/03-cloudfront.sh 를 실행하세요"
elif [ "$DCOUNT" = "1" ]; then
  DIST_ID="$(printf '%s\n' "$DISTS" | awk '{print $1}')"
  DIST_DOMAIN="$(printf '%s\n' "$DISTS" | awk '{print $2}')"
  p_ok "배포 $DIST_ID" "$DIST_DOMAIN"
else
  warn "BookBot 배포가 $DCOUNT 개 있습니다 (중복 — 요금이 이중으로 나갑니다)"
  printf '%s\n' "$DISTS" | awk '{printf "      %s  %s  %s  enabled=%s\n",$1,$2,$3,$4}'

  # ★ "활성화된 첫 번째"로 고르면 안 됩니다.
  #   실제로 옛 배포를 골라서 모든 검증이 403으로 실패한 사고가 있었습니다.
  #   (S3 버킷 정책은 SourceArn 조건으로 하나의 배포만 허용하므로,
  #    잘못 고르면 프론트·API가 전부 403)
  #
  #   판정 기준을 점수화합니다:
  #     +100  API 오리진이 현재 API 호스트와 일치        ← 가장 강한 신호
  #     + 30  사용자 정의 오류 응답이 0개 (최신 설정)
  #     + 10  enabled=True
  BEST=""; BEST_SCORE=-1; BEST_DOMAIN=""
  while read -r d_id d_dom d_st d_en; do
    [ -n "$d_id" ] || continue
    SC=0
    D_API="$(aws cloudfront get-distribution-config --id "$d_id" \
      --query "DistributionConfig.Origins.Items[?Id!='s3-web'].DomainName | [0]" \
      --output text 2>/dev/null || echo '')"
    D_ERR="$(aws cloudfront get-distribution-config --id "$d_id" \
      --query 'DistributionConfig.CustomErrorResponses.Quantity' --output text 2>/dev/null || echo 9)"
    [ -n "$API_HOST" ] && [ "$D_API" = "$API_HOST" ] && SC=$((SC+100))
    [ "$D_ERR" = "0" ] && SC=$((SC+30))
    [ "$d_en" = "True" ] && SC=$((SC+10))
    info "  $d_id  점수 $SC  (api=$D_API errs=$D_ERR)"
    if [ "$SC" -gt "$BEST_SCORE" ]; then
      BEST_SCORE=$SC; BEST="$d_id"; BEST_DOMAIN="$d_dom"
    fi
  done <<EOF
$DISTS
EOF
  DIST_ID="$BEST"; DIST_DOMAIN="$BEST_DOMAIN"
  ok "선택: $DIST_ID ($DIST_DOMAIN) — 점수 $BEST_SCORE"

  OTHERS="$(printf '%s\n' "$DISTS" | awk -v k="$DIST_ID" '$1!=k{print $1}')"
  p_bad "배포 중복 $DCOUNT 개 — 요금이 이중 청구됩니다" \
        "사용: $DIST_ID / 정리 대상: $(printf '%s' "$OTHERS" | tr '\n' ' ')"

  if [ "${PRUNE:-0}" = "1" ] && can_fix; then
    for od in $OTHERS; do
      OE="$(aws cloudfront get-distribution-config --id "$od" --query ETag --output text 2>/dev/null)"
      aws cloudfront get-distribution-config --id "$od" --query DistributionConfig --output json > "$INFRA_DIR/.prune.json" 2>/dev/null
      python3 -c "
import json; p='$INFRA_DIR/.prune.json'
c=json.load(open(p)); c['Enabled']=False; json.dump(c,open(p,'w'))" 2>/dev/null
      aws cloudfront update-distribution --id "$od" \
        --distribution-config "file://$INFRA_DIR/.prune.json" --if-match "$OE" >/dev/null 2>&1 \
        && p_fix "중복 배포 $od 비활성화 (15~25분 후 삭제 가능)" \
        || warn "$od 비활성화 실패"
      rm -f "$INFRA_DIR/.prune.json"
    done
  else
    info "자동 비활성화하려면: PRUNE=1 bash infra/doctor.sh"
  fi
fi

BUCKET=""
if [ -n "$DIST_ID" ]; then
  BUCKET="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
    --query "DistributionConfig.Origins.Items[?Id=='s3-web'].DomainName | [0]" \
    --output text 2>/dev/null | sed 's/\.s3\..*//')"
  [ -n "$BUCKET" ] && [ "$BUCKET" != "None" ] && p_ok "버킷 $BUCKET"
fi

# ── .state 재작성 (다른 스크립트가 쓰도록) ──────────────────
if [ -n "$DIST_ID" ]; then
  cat > "$STATE_FILE" <<EOF
BUCKET_NAME=$BUCKET
API_GW_HOST=$([ "$MODE" = "apigateway" ] && printf '%s' "$API_HOST")
API_ENDPOINT=$([ "$MODE" = "apigateway" ] && printf 'https://%s' "$API_HOST")
API_ID=$API_ID
FUNCTION_URL_HOST=$([ "$MODE" = "lambda-url" ] && printf '%s' "$API_HOST")
DISTRIBUTION_ID=$DIST_ID
DISTRIBUTION_DOMAIN=$DIST_DOMAIN
DISTRIBUTION_ARN=arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}
SITE_URL=https://$DIST_DOMAIN
ORIGIN_SECRET=$ORIGIN_SECRET
EOF
  p_ok ".state 재작성" "AWS 실제 상태 기준"
fi

# ════════════════════════════════════════════════════════════
header "2. 자동 수정"
# ════════════════════════════════════════════════════════════

step "Lambda 핸들러 — 모드와 일치하는지"
WANT_HANDLER="src/index.bufferedHandler"
[ "$MODE" = "lambda-url" ] && WANT_HANDLER="src/index.handler"
if [ "$L_HANDLER" = "$WANT_HANDLER" ]; then
  p_ok "핸들러 $L_HANDLER (모드 $MODE 에 맞음)"
elif can_fix; then
  aws lambda update-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
    --handler "$WANT_HANDLER" >/dev/null 2>&1 \
    && aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION" \
    && p_fix "핸들러 $L_HANDLER → $WANT_HANDLER" \
    || p_bad "핸들러 변경 실패"
  L_HANDLER="$WANT_HANDLER"
else
  p_bad "핸들러 불일치: $L_HANDLER (필요: $WANT_HANDLER)"
fi

step "메모리 / 타임아웃"
NEED_CFG=0
[ "$L_MEM" -lt 1024 ] && NEED_CFG=1
[ "$L_TIMEOUT" -lt 60 ] && NEED_CFG=1
if [ "$NEED_CFG" = "0" ]; then
  p_ok "메모리 ${L_MEM}MB / 타임아웃 ${L_TIMEOUT}s"
elif can_fix; then
  aws lambda update-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
    --memory-size 1024 --timeout 90 >/dev/null 2>&1 \
    && aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION" \
    && p_fix "메모리 1024MB / 타임아웃 90s 로 조정" || p_bad "구성 변경 실패"
else
  p_bad "메모리/타임아웃 부족 (${L_MEM}MB / ${L_TIMEOUT}s)"
fi

step "Bedrock 모델 ID — 실제 호출 테스트"
test_model() {
  aws bedrock-runtime converse --region "${BEDROCK_REGION:-$REGION}" --model-id "$1" \
    --messages '[{"role":"user","content":[{"text":"hi"}]}]' \
    --inference-config '{"maxTokens":5}' >/dev/null 2>&1
}
if [ -n "$L_MODEL" ] && test_model "$L_MODEL"; then
  p_ok "모델 $L_MODEL 호출 성공"
else
  [ -n "$L_MODEL" ] && warn "현재 모델 '$L_MODEL' 호출 실패" || warn "모델 ID가 비어 있습니다"
  if can_fix; then
    info "사용 가능한 모델을 탐색합니다..."
    CANDS="$(aws bedrock list-inference-profiles --region "${BEDROCK_REGION:-$REGION}" \
      --type-equals SYSTEM_DEFINED \
      --query "inferenceProfileSummaries[?contains(inferenceProfileId,'anthropic')].inferenceProfileId" \
      --output text 2>/dev/null | tr '\t' '\n' | grep -Ei 'sonnet|haiku' | grep -v opus || true)"
    PICKED=""
    for m in $(printf '%s\n' "$CANDS" | grep '^us\.' ; printf '%s\n' "$CANDS" | grep '^global\.' ; printf '%s\n' "$CANDS"); do
      [ -n "$m" ] || continue
      printf '    시도 %s ... ' "$m"
      if test_model "$m"; then printf '%s성공%s\n' "$C_GRN" "$C_RST"; PICKED="$m"; break
      else printf '%s실패%s\n' "$C_DIM" "$C_RST"; fi
    done
    if [ -n "$PICKED" ]; then
      CUR="$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
        --query 'Environment.Variables' --output json)"
      NEWENV="$(printf '%s' "$CUR" | python3 -c "
import json,sys
v=json.load(sys.stdin) or {}
v['BEDROCK_MODEL_ID']='$PICKED'
v.setdefault('BEDROCK_REGION','${BEDROCK_REGION:-$REGION}')
v.setdefault('TABLE_NAME','$TABLE_NAME')
v.setdefault('SSM_PREFIX','$SSM_PREFIX')
print(json.dumps({'Variables':v}))")"
      aws lambda update-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
        --environment "$NEWENV" >/dev/null 2>&1 \
        && aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION" \
        && p_fix "모델 ID → $PICKED" || p_bad "모델 ID 설정 실패"
      L_MODEL="$PICKED"
    else
      p_bad "호출 가능한 Bedrock 모델을 찾지 못했습니다" \
        "https://console.aws.amazon.com/bedrock/home?region=${BEDROCK_REGION:-$REGION}#/modelaccess 에서 모델 액세스 승인"
    fi
  else
    p_bad "모델 ID 문제"
  fi
fi

if [ "$MODE" = "apigateway" ] && [ -n "$API_ID" ]; then
  step "API Gateway 배선"
  INTEG="$(aws apigatewayv2 get-integrations --region "$REGION" --api-id "$API_ID" \
    --query 'Items[0].{Id:IntegrationId,T:TimeoutInMillis,P:PayloadFormatVersion}' --output json 2>/dev/null || echo '{}')"
  I_ID="$(printf '%s' "$INTEG" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("Id") or "")')"
  I_T="$(printf '%s' "$INTEG"  | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("T") or 0)')"
  [ -n "$I_ID" ] && p_ok "통합 $I_ID (타임아웃 ${I_T}ms)" || p_bad "Lambda 통합 없음"

  ROUTES="$(aws apigatewayv2 get-routes --region "$REGION" --api-id "$API_ID" \
    --query 'Items[].RouteKey' --output text 2>/dev/null | tr '\t' ' ' || true)"
  case "$ROUTES" in *'/api/{proxy+}'*) p_ok "라우트 ANY /api/{proxy+}" ;;
    *) p_bad "라우트 누락" "현재: $ROUTES / bash infra/05-apigateway.sh 재실행" ;; esac

  STG="$(aws apigatewayv2 get-stage --region "$REGION" --api-id "$API_ID" --stage-name '$default' \
    --query '{Auto:AutoDeploy,Rate:DefaultRouteSettings.ThrottlingRateLimit}' --output json 2>/dev/null || echo '{}')"
  printf '%s' "$STG" | grep -q 'true' && p_ok "스테이지 \$default (자동배포)" || p_bad "스테이지 문제"

  POL="$(aws lambda get-policy --region "$REGION" --function-name "$FUNCTION_NAME" \
    --query Policy --output text 2>/dev/null || true)"
  case "$POL" in *apigateway.amazonaws.com*) p_ok "API Gateway 호출 권한" ;;
    *) if can_fix; then
         aws lambda add-permission --region "$REGION" --function-name "$FUNCTION_NAME" \
           --statement-id AllowApiGatewayInvoke --action lambda:InvokeFunction \
           --principal apigateway.amazonaws.com \
           --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" >/dev/null 2>&1 \
           && p_fix "API Gateway 호출 권한 추가" || p_bad "권한 추가 실패"
       else p_bad "API Gateway 호출 권한 없음"; fi ;;
  esac
fi

step "CloudFront 배선"
if [ -n "$DIST_ID" ]; then
  DC="$(aws cloudfront get-distribution-config --id "$DIST_ID" --query DistributionConfig --output json)"
  CF_API_ORIGIN="$(printf '%s' "$DC" | python3 -c "
import json,sys
c=json.load(sys.stdin)
for o in c['Origins']['Items']:
    if o['Id']!='s3-web': print(o['DomainName']); break
")"
  CF_BEHAV="$(printf '%s' "$DC" | python3 -c "
import json,sys
c=json.load(sys.stdin)
items=(c.get('CacheBehaviors') or {}).get('Items') or []
b=next((x for x in items if x['PathPattern']=='/api/*'), None)
print('yes' if b else 'no', (b or {}).get('Compress'), (b or {}).get('CachePolicyId','')[:8])
")"
  CF_ERRS="$(printf '%s' "$DC" | python3 -c "import json,sys;print((json.load(sys.stdin).get('CustomErrorResponses') or {}).get('Quantity',0))")"

  [ "$CF_API_ORIGIN" = "$API_HOST" ] \
    && p_ok "API 오리진 일치 ($API_HOST)" \
    || p_bad "API 오리진 불일치" "CloudFront=$CF_API_ORIGIN / 실제=$API_HOST → bash infra/03-cloudfront.sh"

  case "$CF_BEHAV" in yes*) p_ok "/api/* 동작 존재 ($CF_BEHAV)" ;;
    *) p_bad "/api/* 동작 없음" "bash infra/03-cloudfront.sh" ;; esac

  [ "$CF_ERRS" = "0" ] \
    && p_ok "사용자 정의 오류 응답 없음 (API 오류가 가려지지 않음)" \
    || p_bad "오류 응답 규칙 $CF_ERRS 개 — API 오류가 HTML로 위장됩니다" "bash infra/03-cloudfront.sh"
fi

# ════════════════════════════════════════════════════════════
header "3. 전파 대기"
# ════════════════════════════════════════════════════════════
if [ -n "$DIST_ID" ] && [ "${NO_WAIT:-0}" != "1" ]; then
  for i in $(seq 1 40); do
    ST="$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.Status' --output text 2>/dev/null || echo '?')"
    [ "$ST" = "Deployed" ] && break
    printf '\r  %s%s ... (%d/40, 30초 간격)%s' "$C_DIM" "$ST" "$i" "$C_RST"
    sleep 30
  done
  printf '\r%*s\r' 70 ''
  [ "$ST" = "Deployed" ] && p_ok "배포 Deployed" || p_bad "아직 $ST — 잠시 후 재실행하세요"
else
  info "전파 대기 생략"
fi

# ════════════════════════════════════════════════════════════
header "4. 사이트 동작 검증"
# ════════════════════════════════════════════════════════════
SITE="https://$DIST_DOMAIN"
info "대상 $SITE"

step "프론트엔드"
C="$(curl -s -o /tmp/bb_i.html -w '%{http_code}' -m 25 "$SITE/" || echo 000)"
if [ "$C" = "200" ] && grep -q 'id="root"' /tmp/bb_i.html; then
  ASSET="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' /tmp/bb_i.html | head -1)"
  p_ok "index.html 200" "$ASSET"
  AC="$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$SITE/$ASSET" || echo 000)"
  [ "$AC" = "200" ] && p_ok "JS 번들 200" || p_bad "JS 번들 $AC"
else
  p_bad "index.html $C"
fi
C="$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$SITE/some/spa/route" || echo 000)"
[ "$C" = "200" ] && p_ok "SPA 라우팅 (없는 경로 → 200)" || p_bad "SPA 라우팅 $C"

step "API 헬스체크"
curl -s -m 30 -o /tmp/bb_h.json -w '%{http_code}' "$SITE/api/health" > /tmp/bb_hc 2>/dev/null || true
HC="$(cat /tmp/bb_hc 2>/dev/null || echo 000)"
if [ "$HC" = "200" ] && head -c1 /tmp/bb_h.json 2>/dev/null | grep -q '{'; then
  python3 - <<'PY'
import json
try: d=json.load(open('/tmp/bb_h.json'))
except Exception: print('  파싱 실패'); raise SystemExit
g='\033[32m'; y='\033[33m'; dm='\033[2m'; x='\033[0m'
b=d.get('bedrock',{}); s=d.get('secrets',{}); dy=d.get('dynamodb',{})
print(f"  {dm}모델 {b.get('modelId')}  범위={b.get('inferenceScope')}{x}")
print(f"  {dm}DDB  ok={dy.get('ok')} {dy.get('latencyMs','')}ms{x}")
print(f"  {dm}키   Google={s.get('GOOGLE_BOOKS_API_KEY')} Hardcover={s.get('HARDCOVER_TOKEN')} OriginSecret={s.get('ORIGIN_SECRET')}{x}")
print(f"  {dm}가드 {d.get('originGuard')}{x}")
for i,p in enumerate(d.get('problems') or [],1): print(f"  {y}!{x} {i}. {p}")
PY
  if grep -q '"problems": *\[\]' /tmp/bb_h.json || grep -q '"problems":\[\]' /tmp/bb_h.json; then
    p_ok "헬스체크 통과 (problems 없음)"
  else
    p_bad "헬스체크에 problems 있음" "위 목록 참고"
  fi
elif [ "$HC" = "200" ]; then
  p_bad "헬스체크가 JSON이 아님 (HTML 반환)" "CloudFront /api/* 동작 또는 오류응답 규칙 확인"
else
  p_bad "헬스체크 HTTP $HC" "$(head -c 200 /tmp/bb_h.json 2>/dev/null)"
fi

step "채팅 (실제 Bedrock + 도서 API)"
Q='무료로 읽을 수 있는 고전 소설 추천해줘'
T0="$(python3 -c 'import time;print(int(time.time()*1000))')"
curl -sN -m 120 -o /tmp/bb_c.txt -w '%{http_code}' -X POST "$SITE/api/chat" \
  -H 'Content-Type: application/json' \
  -d "{\"message\":\"$Q\"}" > /tmp/bb_cc 2>/dev/null || true
CC="$(cat /tmp/bb_cc 2>/dev/null || echo 000)"
T1="$(python3 -c 'import time;print(int(time.time()*1000))')"
info "HTTP $CC / $(( (T1-T0)/1000 )).$(( ((T1-T0)%1000)/100 ))초"

if [ "$CC" = "200" ]; then
  python3 - <<'PY'
import json, re, sys
raw = open('/tmp/bb_c.txt', encoding='utf-8', errors='replace').read()
text=''; books=[]; tools=[]; errs=[]; done=False
if raw.lstrip().startswith('{'):          # 버퍼 JSON 응답
    try:
        d=json.loads(raw)
        text=d.get('answer') or ''
        books=d.get('books') or []
        for e in d.get('events') or []:
            if e.get('type')=='tool_start': tools.append(e.get('name'))
            if e.get('type')=='error': errs.append(e.get('message'))
            if e.get('type')=='done': done=True
    except Exception as ex: errs.append(f'JSON 파싱 실패: {ex}')
else:                                      # SSE 스트림
    for line in raw.splitlines():
        if not line.startswith('data:'): continue
        try: e=json.loads(line[5:].strip())
        except Exception: continue
        t=e.get('type')
        if t=='delta': text+=e.get('text','')
        elif t=='books': books+=e.get('items',[])
        elif t=='tool_start': tools.append(e.get('name'))
        elif t=='error': errs.append(e.get('message'))
        elif t=='done': done=True

dm='\033[2m'; x='\033[0m'; r='\033[31m'
print(f"  {dm}도구 {tools or '없음'} / 도서 {len(books)}권 / 답변 {len(text)}자 / done={done}{x}")
for b in books[:4]:
    free=' [무료]' if b.get('freeEbook') else ''
    rt=(b.get('rating') or {}).get('value')
    print(f"    - {(b.get('title') or '?')[:42]} / {((b.get('authors') or ['?'])[0])[:18]}"
          f"{' ★'+str(rt) if rt else ''}{free} {dm}({'+'.join(b.get('sources',[]))}){x}")
if text: print(f"\n    {text.strip()[:400]}\n")
for e in errs: print(f"  {r}ERROR{x} {e}")

open('/tmp/bb_verdict','w').write(
  'OK' if (books and text and not errs) else ('ERR:'+(errs[0] if errs else 'empty')))
PY
  V="$(cat /tmp/bb_verdict 2>/dev/null || echo 'ERR:unknown')"
  case "$V" in
    OK) p_ok "채팅 정상 (도서 + 답변 수신)" ;;
    *)  p_bad "채팅 실패" "${V#ERR:}" ;;
  esac
else
  p_bad "채팅 HTTP $CC" "$(head -c 300 /tmp/bb_c.txt 2>/dev/null)"
fi

step "보안"
C="$(curl -s -o /dev/null -w '%{http_code}' -m 25 \
  "https://${BUCKET}.s3.${REGION}.amazonaws.com/index.html" || echo 000)"
[ "$C" = "403" ] && p_ok "S3 직접 접근 차단 (403)" || p_bad "S3 직접 접근 허용됨 ($C)"

if [ -n "$API_HOST" ]; then
  C="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "https://$API_HOST/api/chat" \
    -H 'Content-Type: application/json' -d '{"message":"x"}' || echo 000)"
  [ "$C" = "403" ] && p_ok "API 직접 호출 차단 (403, 비밀 헤더 없음)" \
                   || p_bad "API 직접 호출이 통과됨 ($C)" "ORIGIN_SECRET 확인"
fi

C="$(curl -s -o /dev/null -w '%{http_code}' -m 25 "http://${DIST_DOMAIN}/" || echo 000)"
case "$C" in 301|302) p_ok "HTTP → HTTPS 리다이렉트 ($C)" ;; *) warn "HTTP 응답 $C" ;; esac

if [ "${QUICK:-0}" != "1" ]; then
  step "레이트리밋"
  N=$(( RATE_LIMIT_PER_MINUTE + 1 )); HIT=0
  for i in $(seq 1 $N); do
    R="$(curl -s -m 60 -X POST "$SITE/api/chat" -H 'Content-Type: application/json' \
      -d '{"message":"안녕"}' 2>/dev/null | head -c 300)"
    case "$R" in *rate_limited*) HIT=$i; break ;; esac
    printf '\r  %s%d/%d%s' "$C_DIM" "$i" "$N" "$C_RST"
  done
  printf '\r%*s\r' 40 ''
  [ "$HIT" -gt 0 ] && p_ok "레이트리밋 동작 (${HIT}번째 차단)" \
                   || warn "레이트리밋 미작동 (한도 $RATE_LIMIT_PER_MINUTE/분)"
fi

# ════════════════════════════════════════════════════════════
header "결과"
# ════════════════════════════════════════════════════════════
printf '  %s%d 통과%s   %s%d 자동수정%s   %s%d 실패%s\n\n' \
  "$C_GRN" "$PASS" "$C_RST" "$C_GRN" "$FIXED" "$C_RST" \
  "$([ $FAILED -gt 0 ] && printf '%s' "$C_RED" || printf '%s' "$C_DIM")" "$FAILED" "$C_RST"

if [ -s "$FIXES" ]; then
  printf '  %s자동 수정된 항목%s\n' "$C_BLD" "$C_RST"
  sed 's/^/    ✚ /' "$FIXES"
  printf '\n'
fi

if [ $FAILED -gt 0 ]; then
  printf '  %s해결해야 할 항목%s\n' "$C_BLD$C_RED" "$C_RST"
  grep '^FAIL|' "$REPORT" | while IFS='|' read -r _ msg hint; do
    printf '    ✗ %s\n' "$msg"
    [ -n "$hint" ] && printf '        → %s\n' "$hint"
  done
  printf '\n  %s수정 후 다시 실행하세요: bash infra/doctor.sh%s\n\n' "$C_DIM" "$C_RST"
else
  printf '  %s모든 검증 통과%s\n\n' "$C_GRN$C_BLD" "$C_RST"
  printf '  서비스: %s%s%s\n\n' "$C_BLD" "$SITE" "$C_RST"
fi

printf '  %s리소스%s  Lambda=%s(%s)  API=%s  CF=%s  모델=%s\n\n' \
  "$C_DIM" "$C_RST" "$FUNCTION_NAME" "$L_HANDLER" "$MODE" "$DIST_ID" "${L_MODEL:-없음}"

rm -f /tmp/bb_i.html /tmp/bb_h.json /tmp/bb_c.txt /tmp/bb_hc /tmp/bb_cc /tmp/bb_verdict
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
