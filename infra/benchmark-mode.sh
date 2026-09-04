#!/usr/bin/env bash
#
# 벤치마크 모드 켜기/끄기 — 재배포 없이 Lambda 설정만 바꿉니다
#
#   bash infra/benchmark-mode.sh on      벤치마크 실행 전
#   bash infra/benchmark-mode.sh off     끝나면 반드시
#   bash infra/benchmark-mode.sh status  현재 상태만 확인
#
# ══════════════════════════════════════════════════════════════
# 왜 필요한가
# ══════════════════════════════════════════════════════════════
# GuardBench 41건 실행에서 11건이 검증되지 않았습니다. 원인은 타임아웃이 아니라
# **예약 동시성** 이었습니다. 실측:
#
#   동시 35건 → 200 정확히 10건 · 503 25건
#
# 예약 동시성 10 은 "동시 실행 상한" 이라 11번째 요청부터 Lambda 가 시작조차
# 못 하고 API Gateway 가 503 을 돌려줍니다. GuardBench 는 TestCase 를 병렬로
# 던지므로 그대로 막힙니다.
#
#   503 → HttpEndpointHttpClient statusCode>=500 → PROVIDER_UNAVAILABLE
#       → isRetryable=true → 재시도 3회 소진 → FAILED
#
# 동시성만 풀면 다음 벽에 걸립니다. 41건이 전부 Lambda 에 닿으면 IP당 분당 30
# (RLOAI) 을 넘겨 429 가 납니다. 그런데 4xx 는 재시도 대상이 아닙니다.
#
#   429 → TARGET_CONFIGURATION_INVALID → isRetryable=false → 영구 실패
#
# 그래서 둘을 함께 바꿉니다.
#
# ⚠️ on 상태는 비용 방어 3층을 비웁니다. 남는 방어는 IP별 앱 레이트리밋 ·
#    WAF 5분당 300 · Budgets $100 / Bedrock $50 입니다. 끝나면 off 하세요.
# ══════════════════════════════════════════════════════════════
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

MODE="${1:-status}"

# 벤치마크용 / 평상시 값
BM_PER_MIN=150     # 41건 × 재시도 3회 = 최대 123건/분
BM_PER_DAY=600     # 하루 상한은 그대로 — 실질 비용 뚜껑
NORMAL_CONCURRENCY=10
NORMAL_PER_MIN=30
NORMAL_PER_DAY=600

need_fn() {
  aws lambda get-function-configuration --region "$REGION" \
    --function-name "$FUNCTION_NAME" >/dev/null 2>&1 \
    || die "함수 $FUNCTION_NAME 을 찾을 수 없습니다 (리전 $REGION)"
}

show_status() {
  step "현재 상태  $FUNCTION_NAME  ($REGION)"

  local c
  c="$(aws lambda get-function-concurrency --region "$REGION" \
        --function-name "$FUNCTION_NAME" \
        --query 'ReservedConcurrentExecutions' --output text 2>/dev/null || echo "?")"
  if [ "$c" = "None" ] || [ -z "$c" ]; then
    warn "예약 동시성  없음  ← 계정 미예약 풀까지 확장 가능"
  else
    ok "예약 동시성  $c"
  fi

  local env
  env="$(aws lambda get-function-configuration --region "$REGION" \
          --function-name "$FUNCTION_NAME" \
          --query 'Environment.Variables' --output json 2>/dev/null || echo '{}')"
  local pm pd
  pm="$(printf '%s' "$env" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("OPENAI_RATE_LIMIT_PER_MINUTE","(미설정 → 코드 기본값 30)"))' 2>/dev/null)"
  pd="$(printf '%s' "$env" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("OPENAI_RATE_LIMIT_PER_DAY","(미설정 → 코드 기본값 600)"))' 2>/dev/null)"
  info "OpenAI 경로 레이트리밋  분당 $pm · 하루 $pd"
  info "채팅 경로 레이트리밋     분당 ${RATE_LIMIT_PER_MINUTE} · 하루 ${RATE_LIMIT_PER_DAY}  (카운터 분리 — 안 바뀝니다)"
}

# 환경변수를 통째로 덮지 않고 두 키만 바꿔 씁니다.
# --environment 는 전체 교체라서, 기존 값을 읽어 병합해야 다른 설정이 날아가지 않습니다.
set_rate_limits() {
  local per_min="$1" per_day="$2"
  local cur merged
  cur="$(aws lambda get-function-configuration --region "$REGION" \
          --function-name "$FUNCTION_NAME" \
          --query 'Environment.Variables' --output json)" || die "환경변수 조회 실패"

  merged="$(printf '%s' "$cur" | python3 -c '
import json, sys
v = json.load(sys.stdin)
v["OPENAI_RATE_LIMIT_PER_MINUTE"] = sys.argv[1]
v["OPENAI_RATE_LIMIT_PER_DAY"]    = sys.argv[2]
print(json.dumps({"Variables": v}))
' "$per_min" "$per_day")" || die "환경변수 병합 실패"

  printf '%s' "$merged" > "$INFRA_DIR/.bm-env.json"
  if aws lambda update-function-configuration --region "$REGION" \
       --function-name "$FUNCTION_NAME" \
       --environment "file://$INFRA_DIR/.bm-env.json" >/dev/null 2>&1; then
    ok "OpenAI 경로 레이트리밋  분당 $per_min · 하루 $per_day"
  else
    fail "환경변수 갱신 실패"
  fi
  rm -f "$INFRA_DIR/.bm-env.json"
  aws lambda wait function-updated-v2 --region "$REGION" \
    --function-name "$FUNCTION_NAME" 2>/dev/null || true
}

case "$MODE" in
  on)
    need_fn
    step "벤치마크 모드 ON"
    if aws lambda delete-function-concurrency --region "$REGION" \
         --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
      ok "예약 동시성 삭제"
    else
      info "예약 동시성이 이미 없습니다"
    fi
    set_rate_limits "$BM_PER_MIN" "$BM_PER_DAY"
    show_status
    step "다음"
    info "GuardBench Target"
    info "  URL    https://<CloudFront 도메인>/api/v1/chat/completions"
    info "  Model  bookbot"
    warn "끝나면  bash infra/benchmark-mode.sh off"
    ;;

  off)
    need_fn
    step "벤치마크 모드 OFF — 평상시 설정으로"
    if aws lambda put-function-concurrency --region "$REGION" \
         --function-name "$FUNCTION_NAME" \
         --reserved-concurrent-executions "$NORMAL_CONCURRENCY" >/dev/null 2>&1; then
      ok "예약 동시성 $NORMAL_CONCURRENCY 복원"
    else
      warn "예약 동시성 복원 실패 — 계정 미예약분이 10 미만일 수 있습니다"
      info "그 경우 계정 한도 자체가 상한 역할을 합니다"
    fi
    set_rate_limits "$NORMAL_PER_MIN" "$NORMAL_PER_DAY"
    show_status
    warn "infra/config.sh 의 LAMBDA_RESERVED_CONCURRENCY 도 \"10\" 으로 바꿔야"
    info "다음 배포에서 다시 삭제되지 않습니다 (기본값이 none 입니다)"
    ;;

  status)
    need_fn
    show_status
    ;;

  *)
    die "사용법: bash infra/benchmark-mode.sh {on|off|status}"
    ;;
esac
