#!/usr/bin/env bash
#
# 이 리전에서 실제로 쓸 수 있는 Bedrock 모델 / 추론 프로필 ID를 확인합니다.
#
# 왜 필요한가:
#   실습에서 가장 자주 막히는 지점이 modelId입니다.
#   - ap-northeast-2(서울)에서는 `us.anthropic...` 이 동작하지 않습니다 (apac.* 또는 global.*)
#   - 모델 라인업은 계속 바뀝니다. 문서에 적힌 ID를 그대로 믿지 말고 여기서 확인하세요.
#
# 사용법:
#   bash scripts/list-models.sh              # 기본 ap-northeast-2
#   REGION=us-east-1 bash scripts/list-models.sh

set -euo pipefail
REGION="${REGION:-ap-northeast-2}"

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI가 없습니다. 콘솔에서 확인하세요:"
  echo "  Bedrock 콘솔 > Model catalog > 모델 선택 > 'Inference profile IDs' 섹션"
  exit 1
fi

echo "리전: $REGION"
echo
echo "════════ 1. 추론 프로필 (Converse/InvokeModel에 이 ID를 씁니다) ════════"
aws bedrock list-inference-profiles \
  --region "$REGION" \
  --type-equals SYSTEM_DEFINED \
  --query 'inferenceProfileSummaries[].{ID:inferenceProfileId,Name:inferenceProfileName,Status:status}' \
  --output table 2>/dev/null || echo "  (list-inference-profiles 실패 — 권한 또는 CLI 버전 확인)"

echo
echo "════════ 2. 기본 모델 (온디맨드 직접 호출 가능한 것) ════════"
aws bedrock list-foundation-models \
  --region "$REGION" \
  --by-output-modality TEXT \
  --query "modelSummaries[?contains(inferenceTypesSupported, 'ON_DEMAND')].{ID:modelId,Provider:providerName,Streaming:responseStreamingSupported}" \
  --output table 2>/dev/null || echo "  (list-foundation-models 실패)"

echo
echo "════════ 3. 내 계정의 모델 액세스 상태 ════════"
aws bedrock list-foundation-models \
  --region "$REGION" \
  --query "modelSummaries[?providerName=='Anthropic'].{ID:modelId,LifeCycle:modelLifecycle.status}" \
  --output table 2>/dev/null || true

cat <<'EOF'

──────────────────────────────────────────────────────────
고르는 기준:
  * 이름에 'sonnet'  → 품질/속도 균형. 이 프로젝트 기본 추천.
  * 이름에 'haiku'   → 가장 저렴하고 빠름. 비용을 더 아끼려면 이걸로.
  * 접두사 apac.*    → 요청이 APAC 리전 안에서만 처리됨 (데이터 소재지 유리)
  * 접두사 global.*  → 전 세계로 라우팅, 처리량 높고 약 10% 저렴
  * 접두사 없음      → 해당 리전 안에서만 처리 (In-Region). 쿼터가 가장 낮음.

고른 값을 Lambda 환경 변수 BEDROCK_MODEL_ID 에 넣으세요.

호출 테스트:
  aws bedrock-runtime converse \
    --region ap-northeast-2 \
    --model-id '여기에_ID' \
    --messages '[{"role":"user","content":[{"text":"한 문장으로 인사해줘"}]}]' \
    --inference-config '{"maxTokens":100}'
EOF
