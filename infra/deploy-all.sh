#!/usr/bin/env bash
#
# 전체 배포 — 순서대로 실행합니다.
#
#   bash infra/deploy-all.sh
#
# 옵션:
#   REGION=ap-northeast-2 bash infra/deploy-all.sh   # 리전 변경
#   SKIP_WAF=1 bash infra/deploy-all.sh              # WAF 생략 (2주 $3.5 절약)
#
# 전부 idempotent 합니다. 실패한 지점을 고친 뒤 다시 실행하면 됩니다.
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

AWS 서버리스 책 추천 챗봇 — 전체 배포
BANNER
printf '%s' "$C_RST"

bash "$INFRA_DIR/00-preflight.sh" || exit 1
bash "$INFRA_DIR/01-backend.sh"   || die "백엔드 배포 실패"
bash "$INFRA_DIR/02-frontend.sh"  || die "프론트엔드 배포 실패"
bash "$INFRA_DIR/03-cloudfront.sh" || die "CloudFront 배포 실패"
bash "$INFRA_DIR/04-guardrails.sh" || warn "안전장치 일부 실패 — 나중에 재실행하세요"

state_load
ELAPSED=$(( $(date +%s) - START ))

header "배포 완료  (${ELAPSED}초)"

cat <<EOF

  ${C_BLD}서비스 URL${C_RST}
    $(state_get SITE_URL)

  ${C_BLD}리소스${C_RST}
    리전            $REGION
    Lambda          $FUNCTION_NAME
    Function URL    $(state_get FUNCTION_URL_HOST)
    DynamoDB        $TABLE_NAME
    S3              $(state_get BUCKET_NAME)
    CloudFront      $(state_get DISTRIBUTION_ID)

  ${C_YEL}CloudFront 전파에 5~15분 걸립니다.${C_RST}
  지금 접속하면 아직 안 될 수 있습니다. 아래로 준비 상태를 확인하세요:

    ${C_BLD}bash infra/verify.sh${C_RST}

  ${C_DIM}정리(전체 삭제):  bash infra/destroy.sh${C_RST}

EOF
