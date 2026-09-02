#!/usr/bin/env bash
#
#   bash infra/go.sh
#
# 하나의 명령으로 전부 처리합니다.
#
#   1. AWS 로그인 대기          (자격증명이 없으면 안내하며 기다립니다)
#   2. Bedrock 모델 자동 선택   (실제 호출 테스트로 승인된 모델을 찾음)
#   3. 사전 점검
#   4. 전체 배포                (DynamoDB → SSM → IAM → Lambda → S3 → CloudFront → WAF/알람/예산)
#   5. 검증                     (전파 대기 → 헬스체크 → 실제 채팅 → 보안 → 레이트리밋)
#
# 옵션:
#   PREFER=sonnet bash infra/go.sh    품질 우선 모델 (기본은 비용 우선 haiku)
#   SKIP_WAF=1    bash infra/go.sh    WAF 생략 (2주 약 $3.5 절약)
#   NO_WAIT=1     bash infra/go.sh    로그인 대기 없이 즉시 실패
#   REGION=ap-northeast-2 bash infra/go.sh
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

START="$(date +%s)"

printf '%s' "$C_BLD"
cat <<'BANNER'
 ____              _    ____        _
| __ )  ___   ___ | | _| __ )  ___ | |_
|  _ \ / _ \ / _ \| |/ /  _ \ / _ \| __|
| |_) | (_) | (_) |   <| |_) | (_) | |_
|____/ \___/ \___/|_|\_\____/ \___/ \__|
BANNER
printf '%s\n' "$C_RST"
info "리전 $REGION   Bedrock $BEDROCK_REGION"

require_cli

# ════════════════════════════════════════════════════════════
# 1. 로그인 대기
# ════════════════════════════════════════════════════════════
header "1/5  AWS 로그인"

if aws sts get-caller-identity >/dev/null 2>&1; then
  ok "이미 로그인되어 있습니다"
else
  if [ "${NO_WAIT:-0}" = "1" ]; then
    bash "$INFRA_DIR/setup-credentials.sh"
    exit 1
  fi

  cat <<EOF
  ${C_YEL}자격증명이 없습니다.${C_RST} 다른 터미널 창에서 아래를 실행하세요:

    ${C_BLD}aws configure${C_RST}        (IAM 사용자 액세스 키)
      Default region name : ${C_BLD}$REGION${C_RST}

    ${C_BLD}aws configure sso${C_RST}    (회사 계정 / IAM Identity Center)

  자세한 안내:  bash infra/setup-credentials.sh

  ${C_DIM}로그인이 감지되면 자동으로 이어서 진행합니다. 중단하려면 Ctrl+C.${C_RST}

EOF

  WAITED=0
  MAX_WAIT="${MAX_WAIT:-1800}"   # 30분
  while ! aws sts get-caller-identity >/dev/null 2>&1; do
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
      printf '\r%*s\r' 70 ''
      die "로그인 대기 시간이 초과되었습니다 (${MAX_WAIT}초)"
    fi
    printf '\r  %s로그인 대기 중... %d초 경과%s' "$C_DIM" "$WAITED" "$C_RST"
    sleep 5
    WAITED=$((WAITED + 5))
  done
  printf '\r%*s\r' 70 ''
  ok "로그인 감지됨 (${WAITED}초 대기)"
fi

require_creds
ok "계정 $ACCOUNT_ID"
info "주체 $CALLER_ARN"

# ════════════════════════════════════════════════════════════
# 2. Bedrock 모델 선택
# ════════════════════════════════════════════════════════════
header "2/5  Bedrock 모델"

load_secrets
if [ -n "${BEDROCK_MODEL_ID:-}" ]; then
  ok "secrets.env에 이미 지정됨: $BEDROCK_MODEL_ID"
  info "다시 고르려면: rm 후 재실행 또는 bash infra/select-model.sh"
else
  bash "$INFRA_DIR/select-model.sh" || {
    fail "모델을 선택할 수 없습니다"
    printf '\n  %sBedrock 모델 액세스 승인 후 다시 실행하세요:%s\n' "$C_BLD" "$C_RST"
    printf '    https://console.aws.amazon.com/bedrock/home?region=%s#/modelaccess\n' "$BEDROCK_REGION"
    printf '    %sbash infra/go.sh%s\n\n' "$C_BLD" "$C_RST"
    exit 1
  }
  load_secrets
fi

# ════════════════════════════════════════════════════════════
# 3. 사전 점검
# ════════════════════════════════════════════════════════════
header "3/5  사전 점검"
bash "$INFRA_DIR/00-preflight.sh" || {
  fail "사전 점검 실패"
  exit 1
}

# ════════════════════════════════════════════════════════════
# 4. 배포
# ════════════════════════════════════════════════════════════
header "4/5  배포"
bash "$INFRA_DIR/01-backend.sh"    || die "백엔드 배포 실패"
bash "$INFRA_DIR/02-frontend.sh"   || die "프론트엔드 배포 실패"
bash "$INFRA_DIR/03-cloudfront.sh" || die "CloudFront 배포 실패"
bash "$INFRA_DIR/04-guardrails.sh" || warn "안전장치 일부 실패 — bash infra/04-guardrails.sh 로 재시도하세요"

state_load
SITE="$(state_get SITE_URL)"

# ════════════════════════════════════════════════════════════
# 5. 검증
# ════════════════════════════════════════════════════════════
header "5/5  검증"
info "CloudFront 전파를 기다린 뒤 실제 채팅까지 테스트합니다 (5~15분)"
bash "$INFRA_DIR/verify.sh"
VERIFY_RC=$?

# ════════════════════════════════════════════════════════════
ELAPSED=$(( $(date +%s) - START ))
MIN=$(( ELAPSED / 60 )); SEC=$(( ELAPSED % 60 ))

if [ $VERIFY_RC -eq 0 ]; then
  header "완료  (${MIN}분 ${SEC}초)"
else
  header "배포됨 · 검증 일부 실패  (${MIN}분 ${SEC}초)"
fi

cat <<EOF

  ${C_BLD}서비스 URL${C_RST}
    $SITE

    ${C_DIM}open $SITE${C_RST}

  ${C_BLD}리소스${C_RST}
    리전          $REGION
    모델          ${BEDROCK_MODEL_ID:-미설정}
    Lambda        $FUNCTION_NAME
    DynamoDB      $TABLE_NAME
    S3            $(state_get BUCKET_NAME)
    CloudFront    $(state_get DISTRIBUTION_ID)

  ${C_BLD}운영 명령${C_RST}
    로그 실시간   aws logs tail /aws/lambda/$FUNCTION_NAME --region $REGION --follow --format short
    재검증        bash infra/verify.sh
    백엔드 재배포  bash infra/01-backend.sh
    프론트 재배포  bash infra/02-frontend.sh
    ${C_YEL}전체 삭제      bash infra/destroy.sh${C_RST}

  ${C_BLD}비용${C_RST}
    예산 알림이 설정되었습니다 (월 \$100 / Bedrock \$50).
    Cost Explorer로 매일 확인하세요:
    https://console.aws.amazon.com/costmanagement/home#/cost-explorer

    ${C_YEL}2주 뒤 반드시 bash infra/destroy.sh 를 실행하세요.${C_RST}

EOF

exit $VERIFY_RC
