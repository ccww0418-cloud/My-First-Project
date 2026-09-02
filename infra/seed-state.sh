#!/usr/bin/env bash
# ============================================================
#  infra/.state 복원
#
#  왜 필요한가:
#    .state 는 스크립트끼리 값을 주고받는 파일입니다(배포ID, API엔드포인트 등).
#    그런데 이 파일은 CloudShell 번들 zip에 들어가지 않습니다. 비밀값이 아니어도
#    계정마다 달라서 넣으면 안 되기 때문입니다.
#    결과적으로 zip을 다시 풀 때마다 .state 가 사라지고, 그 상태에서
#    04-guardrails.sh 를 실행하면 "CloudFront 배포를 찾을 수 없습니다"로 죽습니다.
#
#    이 스크립트는 AWS에 실제로 존재하는 리소스를 조회해서 .state 를 다시 채웁니다.
#    zip을 새로 풀었으면 다른 스크립트보다 먼저 이걸 한 번 실행하세요.
#
#  설계상 조심한 것 (전에 실제로 사고가 났던 부분):
#    · 버킷 이름을 `aws s3 ls | grep bookbot` 으로 찾지 않습니다.
#      이름이 비슷한 잔여 버킷이 같이 잡혀서 값이 깨진 적이 있습니다.
#      → CloudFront 배포의 오리진에서 역추적합니다. "지금 서비스 중인 그 버킷"이 확실합니다.
#    · 배포가 여러 개일 때 "첫 번째"를 고르지 않습니다.
#      비활성 잔여 배포를 골라서 엉뚱한 곳에 WAF를 붙인 적이 있습니다.
#      → Enabled 인 것만 후보로 삼고, 그래도 2개 이상이면 멈추고 사람에게 묻습니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "상태 파일 복원 (infra/.state)"

require_cli
require_creds

# ────────────────────────────────────────────────────────────
step "CloudFront 배포 찾기"
# ────────────────────────────────────────────────────────────
# 이 프로젝트 것으로 보이는 배포만 추립니다.
# Comment 또는 오리진 도메인에 프로젝트 이름이 들어간 것을 기준으로 합니다.
# AWS 오류 원문을 삼키지 않습니다.
# 전에 2>/dev/null 로 덮어버려서 "권한 거부"를 "리소스 없음"으로 오진한 적이 있습니다.
CF_ERR="$(mktemp)"
LIST="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Comment,'$PROJECT') || contains(Origins.Items[0].DomainName,'$PROJECT')].[Id,DomainName,Enabled,Origins.Items[0].DomainName]" \
  --output text 2>"$CF_ERR" || true)"

if [ -s "$CF_ERR" ]; then
  fail "CloudFront 조회가 실패했습니다. AWS 원문:"
  sed 's/^/      /' "$CF_ERR"
  case "$(cat "$CF_ERR")" in
    *AccessDenied*|*not\ authorized*|*UnauthorizedOperation*|*ExpiredToken*|*InvalidClientTokenId*)
      info "→ 권한 또는 세션 문제입니다. 리소스가 없는 것이 아닙니다."
      info "  이 스크립트는 CloudShell에서 실행하세요. 로컬 CLI는 정책으로 막혀 있습니다."
      ;;
  esac
  rm -f "$CF_ERR"
  exit 1
fi
rm -f "$CF_ERR"

if [ -z "$LIST" ]; then
  die "이 계정에 '$PROJECT' 관련 CloudFront 배포가 없습니다. 먼저 bash infra/03-cloudfront.sh 를 실행하세요."
fi

ENABLED_IDS=""
ENABLED_COUNT=0
while read -r d_id d_dom d_en d_origin; do
  [ -n "${d_id:-}" ] || continue
  if [ "$d_en" = "True" ]; then
    ENABLED_IDS="$ENABLED_IDS $d_id"
    ENABLED_COUNT=$((ENABLED_COUNT + 1))
    info "활성   $d_id  $d_dom"
  else
    info "비활성 $d_id  $d_dom  (후보에서 제외)"
  fi
done <<EOF
$LIST
EOF

if [ "$ENABLED_COUNT" -eq 0 ]; then
  die "활성 상태인 배포가 없습니다. CloudFront 콘솔에서 배포를 Enable 하거나 03-cloudfront.sh 를 실행하세요."
fi

if [ "$ENABLED_COUNT" -gt 1 ]; then
  fail "활성 배포가 $ENABLED_COUNT 개입니다. 어느 것을 쓸지 자동으로 정하지 않습니다."
  info "쓰려는 배포 ID를 직접 지정해서 다시 실행하세요 (위 목록에서 골라 넣으세요):"
  info "  DISTRIBUTION_ID=<배포ID> bash infra/seed-state.sh"
  [ -n "${DISTRIBUTION_ID:-}" ] || exit 1
fi

# 환경변수로 넘어온 값이 있으면 그것을 우선합니다.
DIST_ID="${DISTRIBUTION_ID:-$(printf '%s' "$ENABLED_IDS" | awk '{print $1}')}"

DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" \
  --query 'Distribution.DomainName' --output text 2>/dev/null || true)"
[ -n "$DIST_DOMAIN" ] && [ "$DIST_DOMAIN" != "None" ] \
  || die "배포 $DIST_ID 를 조회할 수 없습니다. ID를 확인하세요."

state_set DISTRIBUTION_ID "$DIST_ID"
state_set DISTRIBUTION_DOMAIN "$DIST_DOMAIN"
state_set DISTRIBUTION_ARN "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"
ok "배포 $DIST_ID  ($DIST_DOMAIN)"

# ────────────────────────────────────────────────────────────
step "S3 버킷 — 배포 오리진에서 역추적"
# ────────────────────────────────────────────────────────────
# grep 으로 버킷 목록을 훑지 않는 이유는 파일 맨 위 주석에 적어두었습니다.
ORIGINS="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
  --query 'DistributionConfig.Origins.Items[].DomainName' --output text 2>/dev/null || true)"

BUCKET=""
for o in $ORIGINS; do
  case "$o" in
    *.s3.*amazonaws.com|*.s3-website*.amazonaws.com)
      BUCKET="${o%%.s3.*}"
      BUCKET="${BUCKET%%.s3-website*}"
      break
      ;;
  esac
done

if [ -n "$BUCKET" ]; then
  state_set BUCKET_NAME "$BUCKET"
  ok "버킷 $BUCKET"
else
  warn "배포 오리진에서 S3 버킷을 찾지 못했습니다 (오리진: ${ORIGINS:-없음})"
  warn "기본 규칙으로 대체합니다: ${PROJECT}-web-${ACCOUNT_ID}-${REGION}"
  state_set BUCKET_NAME "${PROJECT}-web-${ACCOUNT_ID}-${REGION}"
fi

# ────────────────────────────────────────────────────────────
step "API Gateway 엔드포인트"
# ────────────────────────────────────────────────────────────
API_NAME="${PROJECT}-http-api"
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text 2>/dev/null || true)"

if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  API_ENDPOINT="$(aws apigatewayv2 get-api --region "$REGION" --api-id "$API_ID" \
    --query ApiEndpoint --output text)"
  API_HOST="$(printf '%s' "$API_ENDPOINT" | sed -E 's#^https?://##; s#/+$##')"
  state_set API_ID "$API_ID"
  state_set API_ENDPOINT "$API_ENDPOINT"
  state_set API_GW_HOST "$API_HOST"
  ok "API $API_ID  ($API_ENDPOINT)"
else
  warn "$API_NAME 을 찾지 못했습니다. 필요하면 bash infra/05-apigateway.sh 를 실행하세요."
fi

# ────────────────────────────────────────────────────────────
step "WAF Web ACL (있으면 기록)"
# ────────────────────────────────────────────────────────────
WAF_ARN="$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 \
  --query "WebACLs[?Name=='$WAF_NAME'].ARN | [0]" --output text 2>/dev/null || true)"
if [ -n "$WAF_ARN" ] && [ "$WAF_ARN" != "None" ]; then
  state_set WAF_ARN "$WAF_ARN"
  ok "Web ACL 발견"
else
  info "Web ACL 없음 — 04-guardrails.sh 가 새로 만듭니다"
fi

# ────────────────────────────────────────────────────────────
header "복원 완료"
# ────────────────────────────────────────────────────────────
info "$STATE_FILE"
sed 's/^/    /' "$STATE_FILE"
printf '\n'
info "이제 다른 스크립트를 실행하세요. 예:  bash infra/04-guardrails.sh"
