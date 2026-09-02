#!/usr/bin/env bash
# ============================================================
#  코드 갱신 배포 — 한 명령으로
#
#  이 스크립트는 "이미 만들어진 AWS 자원에 새 코드를 올리는" 경우용입니다.
#  처음 구축은 infra/go.sh 또는 infra/deploy-all.sh 를 쓰세요.
#
#  사용법
#    bash infra/update.sh              백엔드 + 프론트엔드 전부
#    ONLY=backend  bash infra/update.sh   백엔드만
#    ONLY=frontend bash infra/update.sh   프론트엔드만
#    SKIP_DOCTOR=1 bash infra/update.sh   검증 생략 (빠르게)
#
#  왜 이 스크립트가 필요한가:
#    매번 손으로 아래 다섯 단계를 순서대로 쳤습니다.
#      seed-state → 01-backend → 02-frontend → 캐시 무효화 → doctor
#    순서를 틀리면(특히 seed-state 를 빼먹으면) 배포 ID를 못 찾아 실패합니다.
#    실수할 여지를 없애려고 하나로 묶었습니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

START=$(date +%s)
ONLY="${ONLY:-all}"

header "코드 갱신 배포"

require_cli
require_creds

# ────────────────────────────────────────────────────────────
# 1) 상태 파일 복원
# ────────────────────────────────────────────────────────────
# git clone 이나 zip 압축 해제 직후에는 infra/.state 가 없습니다.
# (계정마다 값이 달라 저장소에 넣지 않는 파일입니다)
# 그 상태로 다른 스크립트를 돌리면 "CloudFront 배포를 찾을 수 없습니다"로 죽습니다.
if [ ! -s "$STATE_FILE" ] || [ -z "$(state_get DISTRIBUTION_ID)" ]; then
  info "상태 파일이 없어 AWS 에서 복원합니다"
  bash "$INFRA_DIR/seed-state.sh" || die "상태 복원 실패 — 위 메시지를 확인하세요"
  state_load
else
  skip "상태 파일 (배포 $(state_get DISTRIBUTION_ID))"
fi

DIST_ID="$(state_get DISTRIBUTION_ID)"
[ -n "$DIST_ID" ] || die "DISTRIBUTION_ID 를 확정하지 못했습니다"

# secrets.env 가 없으면 외부 API 키가 빈 값으로 덮여 품질이 크게 떨어집니다.
# 조용히 진행하지 않고 분명히 경고합니다.
if [ ! -f "$SECRETS_FILE" ]; then
  warn "infra/secrets.env 가 없습니다"
  warn "Google Books / Hardcover 키 없이 배포되어 추천 품질이 떨어집니다"
  warn "  cp infra/secrets.env.example infra/secrets.env  후 값을 채우세요"
fi

# ────────────────────────────────────────────────────────────
# 2) 백엔드
# ────────────────────────────────────────────────────────────
if [ "$ONLY" = "all" ] || [ "$ONLY" = "backend" ]; then
  bash "$INFRA_DIR/01-backend.sh" || die "백엔드 배포 실패"
else
  skip "백엔드 (ONLY=$ONLY)"
fi

# ────────────────────────────────────────────────────────────
# 3) 프론트엔드
# ────────────────────────────────────────────────────────────
if [ "$ONLY" = "all" ] || [ "$ONLY" = "frontend" ]; then
  bash "$INFRA_DIR/02-frontend.sh" || die "프론트엔드 배포 실패"

  # ──────────────────────────────────────────────────────────
  step "CloudFront 캐시 무효화"
  # ──────────────────────────────────────────────────────────
  # 이걸 빼먹으면 사용자는 최대 24시간 동안 옛 화면을 봅니다.
  # index.html 은 no-cache 지만 assets/*.js 는 1년 캐시라서
  # 새 파일 이름을 알려면 index.html 이 갱신되어야 합니다.
  INV_ID="$(aws cloudfront create-invalidation \
    --distribution-id "$DIST_ID" --paths '/*' \
    --query 'Invalidation.Id' --output text 2>"$INFRA_DIR/.inv-err")" || {
      fail "무효화 요청 실패. AWS 원문:"
      sed 's/^/      /' "$INFRA_DIR/.inv-err" | head -3
      rm -f "$INFRA_DIR/.inv-err"
      die "CloudFront 캐시가 갱신되지 않았습니다"
    }
  rm -f "$INFRA_DIR/.inv-err"
  ok "무효화 $INV_ID 요청 (전파에 1~3분)"
else
  skip "프론트엔드 (ONLY=$ONLY)"
fi

# ────────────────────────────────────────────────────────────
# 4) 검증
# ────────────────────────────────────────────────────────────
if [ "${SKIP_DOCTOR:-0}" = "1" ]; then
  skip "검증 (SKIP_DOCTOR=1)"
else
  # doctor.sh 는 진단 + 자동수정 + 실제 사이트 호출까지 합니다.
  QUICK=1 bash "$INFRA_DIR/doctor.sh" || warn "검증에서 문제를 보고했습니다 (위 내용 확인)"
fi

ELAPSED=$(( $(date +%s) - START ))
header "갱신 완료  (${ELAPSED}초)"
info "사이트: https://$(state_get DISTRIBUTION_DOMAIN)"
info "캐시 전파에 1~3분 걸립니다. 바로 안 바뀌면 잠시 후 새로고침하세요."
printf '\n'
