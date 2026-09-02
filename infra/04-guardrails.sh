#!/usr/bin/env bash
#
# 비용/보안 안전장치: WAF → SNS → CloudWatch 알람 → AWS Budgets
#
# 이 스크립트가 만드는 것이 "비용 폭탄 4중 방어"의 2·4번째 층입니다.
#   1층 앱 레이트리밋 (DynamoDB)      → 코드에 내장
#   2층 WAF rate-based rule            → 여기
#   3층 Lambda 예약 동시성 10          → 01-backend.sh
#   4층 Budgets 알림                   → 여기
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "4/4  안전장치 (WAF · 알람 · 예산)"

require_cli
require_creds
load_secrets
state_load

DIST_ID="$(state_get DISTRIBUTION_ID)"
[ -n "$DIST_ID" ] || die "CloudFront 배포를 찾을 수 없습니다. 먼저 bash infra/03-cloudfront.sh 를 실행하세요."

SKIP_WAF="${SKIP_WAF:-0}"

# ────────────────────────────────────────────────────────────
step "AWS WAF — 레이트 기반 차단"
# ────────────────────────────────────────────────────────────
# CloudFront용 WAF는 반드시 us-east-1 / scope=CLOUDFRONT 입니다.
if [ "$SKIP_WAF" = "1" ]; then
  warn "SKIP_WAF=1 — WAF를 건너뜁니다 (2주에 약 \$3.5 절약, 대신 방어 1층 감소)"
else
  WAF_ARN="$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 \
    --query "WebACLs[?Name=='$WAF_NAME'].ARN | [0]" --output text 2>/dev/null || true)"

  RULES_JSON="$(cat <<'JSON'
[
  {
    "Name": "RateLimitPerIP",
    "Priority": 0,
    "Statement": {
      "RateBasedStatement": {
        "Limit": 300,
        "EvaluationWindowSec": 300,
        "AggregateKeyType": "IP"
      }
    },
    "Action": {"Block": {}},
    "VisibilityConfig": {
      "SampledRequestsEnabled": true,
      "CloudWatchMetricsEnabled": true,
      "MetricName": "RateLimitPerIP"
    }
  },
  {
    "Name": "RateLimitChatEndpoint",
    "Priority": 1,
    "Statement": {
      "RateBasedStatement": {
        "Limit": 100,
        "EvaluationWindowSec": 300,
        "AggregateKeyType": "IP",
        "ScopeDownStatement": {
          "ByteMatchStatement": {
            "SearchString": "/api/chat",
            "FieldToMatch": {"UriPath": {}},
            "TextTransformations": [{"Priority": 0, "Type": "LOWERCASE"}],
            "PositionalConstraint": "STARTS_WITH"
          }
        }
      }
    },
    "Action": {"Block": {}},
    "VisibilityConfig": {
      "SampledRequestsEnabled": true,
      "CloudWatchMetricsEnabled": true,
      "MetricName": "RateLimitChatEndpoint"
    }
  }
]
JSON
)"
  VIS_JSON="{\"SampledRequestsEnabled\":true,\"CloudWatchMetricsEnabled\":true,\"MetricName\":\"$WAF_NAME\"}"

  if [ -n "$WAF_ARN" ] && [ "$WAF_ARN" != "None" ]; then
    skip "Web ACL $WAF_NAME"
  else
    WAF_ARN="$(aws wafv2 create-web-acl \
      --name "$WAF_NAME" \
      --scope CLOUDFRONT \
      --region us-east-1 \
      --default-action '{"Allow":{}}' \
      --rules "$RULES_JSON" \
      --visibility-config "$VIS_JSON" \
      --description "BookBot rate limiting" \
      --query 'Summary.ARN' --output text 2>"$INFRA_DIR/.waf-err")" || {
        warn "WAF 생성 실패:"; sed 's/^/      /' "$INFRA_DIR/.waf-err" | head -3; WAF_ARN=""; }
    rm -f "$INFRA_DIR/.waf-err"
    [ -n "$WAF_ARN" ] && [ "$WAF_ARN" != "None" ] && ok "Web ACL 생성 (IP당 5분간 300회 / /api/chat은 100회)"
  fi

  # 배포에 연결 — CloudFront 설정의 WebACLId를 갱신해야 합니다
  if [ -n "$WAF_ARN" ] && [ "$WAF_ARN" != "None" ]; then
    state_set WAF_ARN "$WAF_ARN"
    CUR_ACL="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
      --query 'DistributionConfig.WebACLId' --output text 2>/dev/null || echo "")"
    if [ "$CUR_ACL" = "$WAF_ARN" ]; then
      skip "배포에 이미 연결됨"
    else
      TMP="$INFRA_DIR/.cf-waf.json"
      ETAG="$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text)"
      aws cloudfront get-distribution-config --id "$DIST_ID" \
        --query 'DistributionConfig' --output json > "$TMP"
      python3 - "$TMP" "$WAF_ARN" <<'PY'
import json, sys
p = sys.argv[1]
cfg = json.load(open(p))
cfg['WebACLId'] = sys.argv[2]
json.dump(cfg, open(p, 'w'))
PY
      aws cloudfront update-distribution --id "$DIST_ID" \
        --distribution-config "file://$TMP" --if-match "$ETAG" >/dev/null \
        && ok "배포에 WAF 연결" || warn "WAF 연결 실패 (콘솔에서 수동 연결하세요)"
      rm -f "$TMP"
    fi
  fi
fi

# ────────────────────────────────────────────────────────────
step "SNS 주제 — 알람 수신"
# ────────────────────────────────────────────────────────────
TOPIC_ARN="$(aws sns create-topic --name "$SNS_TOPIC_NAME" --region "$REGION" \
  --query TopicArn --output text)" || die "SNS 주제 생성 실패"
ok "주제 $SNS_TOPIC_NAME"
state_set SNS_TOPIC_ARN "$TOPIC_ARN"

if [ -n "${ALERT_EMAIL:-}" ]; then
  ALREADY="$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --region "$REGION" \
    --query "Subscriptions[?Endpoint=='$ALERT_EMAIL'].SubscriptionArn | [0]" --output text 2>/dev/null || true)"
  if [ -n "$ALREADY" ] && [ "$ALREADY" != "None" ]; then
    skip "이메일 구독 $ALERT_EMAIL"
  else
    aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email \
      --notification-endpoint "$ALERT_EMAIL" --region "$REGION" >/dev/null
    ok "이메일 구독 요청 → $ALERT_EMAIL"
    warn "받은 메일의 'Confirm subscription' 링크를 클릭해야 알림이 옵니다"
  fi
else
  warn "ALERT_EMAIL 미설정 — 알람이 발생해도 메일이 안 옵니다 (infra/secrets.env)"
fi

# ────────────────────────────────────────────────────────────
step "CloudWatch 알람"
# ────────────────────────────────────────────────────────────
put_alarm() {
  local name="$1" desc="$2" ns="$3" metric="$4" stat="$5" period="$6" threshold="$7" dims="$8"
  # macOS 기본 bash는 3.2입니다. set -u 에서 빈 배열을 "${arr[@]}" 로 확장하면
  # "unbound variable" 로 죽습니다. 배열을 쓰지 않고 분기로 처리합니다.
  if [ -n "$dims" ]; then
    aws cloudwatch put-metric-alarm \
      --region "$REGION" --alarm-name "$name" --alarm-description "$desc" \
      --namespace "$ns" --metric-name "$metric" --statistic "$stat" \
      --period "$period" --evaluation-periods 1 --threshold "$threshold" \
      --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
      --alarm-actions "$TOPIC_ARN" --dimensions "$dims" >/dev/null 2>&1
  else
    aws cloudwatch put-metric-alarm \
      --region "$REGION" --alarm-name "$name" --alarm-description "$desc" \
      --namespace "$ns" --metric-name "$metric" --statistic "$stat" \
      --period "$period" --evaluation-periods 1 --threshold "$threshold" \
      --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
      --alarm-actions "$TOPIC_ARN" >/dev/null 2>&1
  fi
  # shellcheck disable=SC2181
  if [ $? -eq 0 ]; then ok "$name (임계값 $threshold)"; else warn "$name 생성 실패"; fi
}

put_alarm "${PROJECT}-lambda-errors" "Lambda 오류 급증" \
  AWS/Lambda Errors Sum 300 5 "Name=FunctionName,Value=$FUNCTION_NAME"

put_alarm "${PROJECT}-lambda-throttles" "예약 동시성 한도 도달 = 트래픽 급증" \
  AWS/Lambda Throttles Sum 300 10 "Name=FunctionName,Value=$FUNCTION_NAME"

put_alarm "${PROJECT}-lambda-duration" "응답 시간 이상 (60초 초과)" \
  AWS/Lambda Duration Average 300 60000 "Name=FunctionName,Value=$FUNCTION_NAME"

# Bedrock 토큰 알람 — 비용 조기 경보. 지표는 첫 호출 후에 생성됩니다.
if [ -n "${BEDROCK_MODEL_ID:-}" ]; then
  put_alarm "${PROJECT}-bedrock-token-spike" "시간당 출력 토큰 20만 초과 = 비용 급증" \
    AWS/Bedrock OutputTokenCount Sum 3600 200000 ""
fi

# ────────────────────────────────────────────────────────────
step "AWS Budgets — 예산 알림"
# ────────────────────────────────────────────────────────────
BUDGET_LIMIT="${BUDGET_LIMIT:-100}"
BEDROCK_BUDGET_LIMIT="${BEDROCK_BUDGET_LIMIT:-50}"

make_budget() {
  local name="$1" amount="$2" service_filter="$3"
  local budget_json notif_json

  if [ -n "$service_filter" ]; then
    budget_json="$(python3 -c "
import json
print(json.dumps({
  'BudgetName': '$name',
  'BudgetLimit': {'Amount': '$amount', 'Unit': 'USD'},
  'TimeUnit': 'MONTHLY',
  'BudgetType': 'COST',
  'CostFilters': {'Service': ['Amazon Bedrock']}
}))")"
  else
    budget_json="$(python3 -c "
import json
print(json.dumps({
  'BudgetName': '$name',
  'BudgetLimit': {'Amount': '$amount', 'Unit': 'USD'},
  'TimeUnit': 'MONTHLY',
  'BudgetType': 'COST'
}))")"
  fi

  # 알림: 실제 50%, 실제 80%, 예측 100%
  local subs="[]"
  if [ -n "${ALERT_EMAIL:-}" ]; then
    subs="$(python3 -c "
import json
print(json.dumps([{'SubscriptionType':'EMAIL','Address':'$ALERT_EMAIL'}]))")"
  fi

  if [ "$subs" = "[]" ]; then
    aws budgets create-budget --account-id "$ACCOUNT_ID" --budget "$budget_json" >/dev/null 2>&1 \
      && ok "$name (\$$amount/월, 알림 대상 없음)" \
      || skip "$name"
    return
  fi

  notif_json="$(python3 -c "
import json
subs = json.loads('''$subs''')
print(json.dumps([
  {'Notification': {'NotificationType':'ACTUAL','ComparisonOperator':'GREATER_THAN','Threshold':50,'ThresholdType':'PERCENTAGE'}, 'Subscribers': subs},
  {'Notification': {'NotificationType':'ACTUAL','ComparisonOperator':'GREATER_THAN','Threshold':80,'ThresholdType':'PERCENTAGE'}, 'Subscribers': subs},
  {'Notification': {'NotificationType':'FORECASTED','ComparisonOperator':'GREATER_THAN','Threshold':100,'ThresholdType':'PERCENTAGE'}, 'Subscribers': subs}
]))")"

  aws budgets create-budget \
    --account-id "$ACCOUNT_ID" \
    --budget "$budget_json" \
    --notifications-with-subscribers "$notif_json" >/dev/null 2>&1 \
    && ok "$name (\$$amount/월, 50%·80%·예측100% 알림)" \
    || skip "$name"
}

make_budget "${PROJECT}-monthly" "$BUDGET_LIMIT" ""
make_budget "${PROJECT}-bedrock-only" "$BEDROCK_BUDGET_LIMIT" "bedrock"

printf '\n'
ok "안전장치 완료"
