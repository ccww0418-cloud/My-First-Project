#!/usr/bin/env bash
# ============================================================
#  사이트 도메인만 한 줄로 출력
#
#    bash infra/print-domain.sh
#    → CLOUDFRONT_DOMAIN_MASKED.cloudfront.net
#
#  왜 필요한가:
#    curl 명령에 도메인을 넣으려고 매번 .state 를 열거나 콘솔을 뒤졌습니다.
#    config.sh 를 source 하면 배너가 함께 출력되어 파이프에 섞입니다.
#    그래서 배너를 버리고 값만 내보내는 얇은 래퍼를 둡니다.
# ============================================================
set -uo pipefail

# config.sh 의 안내 출력은 stderr 로 흘려보내고 값만 stdout 에 남깁니다.
source "$(dirname "${BASH_SOURCE[0]}")/config.sh" >/dev/null 2>&1

DOMAIN="$(state_get DISTRIBUTION_DOMAIN 2>/dev/null || true)"

# .state 가 없는 경우(zip 압축 해제 직후) AWS 에서 직접 찾습니다.
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?contains(Comment,'bookbot')]|[0].DomainName" \
    --output text 2>/dev/null || true)"
  [ "$DOMAIN" = "None" ] && DOMAIN=""
fi

if [ -z "$DOMAIN" ]; then
  echo "도메인을 찾지 못했습니다. bash infra/seed-state.sh 를 먼저 실행하세요." >&2
  exit 1
fi

printf '%s\n' "$DOMAIN"
