#!/usr/bin/env bash
#
#   bash infra/bedrock-probe.sh
#
# Lambda가 Bedrock에 보내는 요청을 단계별로 재현해서 무엇이 거부되는지 정확히 찾습니다.
#
# 왜 필요한가:
#   `aws bedrock-runtime converse` 단순 호출은 성공하는데 Lambda의 ConverseStream이
#   ValidationException으로 실패하는 상황이 있었습니다. 차이는 세 가지입니다.
#     ① converse vs converse-stream
#     ② toolConfig 유무
#     ③ inferenceConfig 에 topP 포함 여부
#   하나씩 켜가며 어디서 깨지는지 확인합니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

require_cli
require_creds

MODEL="${BEDROCK_MODEL_ID:-}"
if [ -z "$MODEL" ]; then
  MODEL="$(aws lambda get-function-configuration --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --query 'Environment.Variables.BEDROCK_MODEL_ID' --output text 2>/dev/null || true)"
fi
BR="${BEDROCK_REGION:-$REGION}"

header "Bedrock 요청 재현 진단"
info "모델  $MODEL"
info "리전  $BR"
[ -n "$MODEL" ] && [ "$MODEL" != "None" ] || die "모델 ID를 찾을 수 없습니다"

MSG='[{"role":"user","content":[{"text":"한 단어로 답해: 안녕"}]}]'
TOOLS='{"tools":[{"toolSpec":{"name":"probe_tool","description":"진단용 도구","inputSchema":{"json":{"type":"object","properties":{"query":{"type":"string","description":"검색어"}},"required":["query"]}}}}]}'

RESULT_FILE="$INFRA_DIR/.probe-out"
FIRST_FAIL=""

# 반환값: 0=성공, 1=AWS가 거부, 2=CLI에 서브커맨드가 없음(판정 불가)
run() {
  local label="$1"; shift
  printf '  %-52s ' "$label"
  if "$@" > "$RESULT_FILE" 2>&1; then
    printf '%s성공%s\n' "$C_GRN" "$C_RST"
    return 0
  fi

  # ★ CLI 자체의 한계와 AWS의 거부를 구분해야 합니다.
  #   CloudShell의 AWS CLI 버전에는 converse-stream 서브커맨드가 없을 수 있는데,
  #   그건 모델의 문제가 아닙니다(Lambda는 SDK로 호출하므로 무관).
  #   예전 판정 로직이 이걸 "모델이 스트리밍 미지원"으로 오해했습니다.
  if grep -q 'Found invalid choice\|ParamValidation' "$RESULT_FILE"; then
    printf '%s판정불가%s %s(이 CLI 버전에 해당 서브커맨드 없음 — Lambda는 SDK 사용이라 무관)%s\n' \
      "$C_YEL" "$C_RST" "$C_DIM" "$C_RST"
    return 2
  fi

  printf '%s거부%s\n' "$C_RED" "$C_RST"
  ERRLINE="$(grep -oE '\(([A-Za-z]+Exception)\)[^"]*' "$RESULT_FILE" | head -1)"
  [ -z "$ERRLINE" ] && ERRLINE="$(head -3 "$RESULT_FILE" | tr '\n' ' ')"
  printf '      %s%s%s\n' "$C_DIM" "$(printf '%s' "$ERRLINE" | cut -c1-260)" "$C_RST"
  [ -z "$FIRST_FAIL" ] && FIRST_FAIL="$label"
  return 1
}

step "1) converse — 도구 없음, temperature만"
run "converse / maxTokens+temperature" \
  aws bedrock-runtime converse --region "$BR" --model-id "$MODEL" \
    --messages "$MSG" --inference-config '{"maxTokens":50,"temperature":0.4}'
OK_BASE=$?

step "2) converse — temperature + topP 동시 지정"
# Anthropic: "You should either alter temperature or top_p, but not both."
run "converse / temperature + topP  (동시 지정)" \
  aws bedrock-runtime converse --region "$BR" --model-id "$MODEL" \
    --messages "$MSG" --inference-config '{"maxTokens":50,"temperature":0.4,"topP":0.9}'
OK_TOPP=$?

step "3) converse — toolConfig 포함"
run "converse / + toolConfig" \
  aws bedrock-runtime converse --region "$BR" --model-id "$MODEL" \
    --messages "$MSG" --inference-config '{"maxTokens":50,"temperature":0.4}' \
    --tool-config "$TOOLS"
OK_TOOLS=$?

step "4) converse-stream — 도구 없음"
run "converse-stream / temperature만" \
  aws bedrock-runtime converse-stream --region "$BR" --model-id "$MODEL" \
    --messages "$MSG" --inference-config '{"maxTokens":50,"temperature":0.4}'

step "5) converse-stream + toolConfig  ← 수정 후 Lambda 구성"
run "converse-stream / + toolConfig (topP 없음)" \
  aws bedrock-runtime converse-stream --region "$BR" --model-id "$MODEL" \
    --messages "$MSG" --inference-config '{"maxTokens":50,"temperature":0.4}' \
    --tool-config "$TOOLS"
OK_FIXED=$?

step "6) converse-stream + toolConfig + topP  ← 수정 전 Lambda 구성"
run "converse-stream / + toolConfig + topP" \
  aws bedrock-runtime converse-stream --region "$BR" --model-id "$MODEL" \
    --messages "$MSG" --inference-config '{"maxTokens":50,"temperature":0.4,"topP":0.9}' \
    --tool-config "$TOOLS"
OK_OLD=$?

step "7) 시스템 프롬프트 포함 (실제 구성에 가장 가까움)"
run "converse-stream / + system + toolConfig" \
  aws bedrock-runtime converse-stream --region "$BR" --model-id "$MODEL" \
    --messages "$MSG" --system '[{"text":"당신은 책을 추천하는 사서입니다."}]' \
    --inference-config '{"maxTokens":50,"temperature":0.4}' \
    --tool-config "$TOOLS"

rm -f "$RESULT_FILE"

header "판정"

# converse-stream 은 CLI 버전에 따라 없을 수 있습니다(반환값 2 = 판정불가).
# 그 경우 converse 결과로 추론합니다. Lambda는 SDK를 쓰므로 스트리밍 지원 여부는
# 모델 카드의 'Response streaming' 항목으로 판단해야 합니다.
STREAM_TESTABLE=1
[ "$OK_FIXED" -eq 2 ] && STREAM_TESTABLE=0

if [ "$OK_TOPP" -eq 1 ] && [ "$OK_BASE" -eq 0 ]; then
  ok "원인 확정 — temperature 와 topP 를 동시에 지정하면 이 모델이 거부합니다"
  cat <<EOF

    AWS 원문: \`temperature\` and \`top_p\` cannot both be specified for this model.

    Anthropic 문서도 같은 내용입니다:
      "You should either alter temperature or top_p, but not both."

    ${C_BLD}해결: agent.mjs 에서 topP 를 제거했습니다.${C_RST}
    최신 코드를 배포하세요:

      bash infra/01-backend.sh
      QUICK=1 bash infra/doctor.sh

EOF
elif [ "$OK_BASE" -ne 0 ]; then
  fail "기본 converse 호출부터 실패합니다 — 모델 액세스 또는 모델 ID 문제입니다"
  info "https://console.aws.amazon.com/bedrock/home?region=$BR#/modelaccess"
elif [ "$OK_TOOLS" -ne 0 ]; then
  fail "toolConfig 를 붙이면 실패합니다 — 이 모델이 도구 사용을 지원하지 않습니다"
  info "Bedrock 콘솔 > 모델 카탈로그 > 모델 상세 > 'Client-side tool calling' 확인"
  info "대안 모델: us.anthropic.claude-haiku-4-5-20251001-v1:0 / global.anthropic.claude-sonnet-4-6"
elif [ "$STREAM_TESTABLE" -eq 0 ]; then
  ok "converse + toolConfig 정상 (topP 없이)"
  warn "converse-stream 은 이 CLI 버전으로 검증할 수 없습니다"
  info "Lambda는 AWS SDK로 호출하므로 CLI 한계와 무관합니다."
  info "모델 카드의 'Response streaming' 지원 여부만 확인하면 됩니다."
elif [ "$OK_FIXED" -eq 0 ]; then
  ok "converse-stream + toolConfig 정상 (topP 없이)"
else
  fail "converse-stream + toolConfig 실패"
  info "Lambda 로그의 AWS 원문을 확인하세요:"
  info "  aws logs tail /aws/lambda/$FUNCTION_NAME --region $REGION --since 10m --format short | grep -A3 'Bedrock 호출 실패'"
fi

[ -n "$FIRST_FAIL" ] && info "첫 거부 지점: $FIRST_FAIL"
printf '\n'
