#!/usr/bin/env bash
#
# 전체 삭제 — 2주 실습이 끝난 뒤 실행합니다.
#
#   bash infra/destroy.sh          # 확인 프롬프트 있음
#   FORCE=1 bash infra/destroy.sh  # 프롬프트 없이 진행
#
# ⚠️ 되돌릴 수 없습니다. 삭제 전에 화면 녹화와 비용 스크린샷을 남기세요.
#
# 삭제 순서가 중요합니다. 의존 관계 때문에 역순으로 지우면 실패합니다:
#   WAF 연결 해제 → CloudFront 비활성화 → 삭제 → WAF 삭제 → S3 비우기 → 삭제
#   → Lambda → DynamoDB → SSM → IAM → 로그 → 알람 → SNS → 예산
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

require_cli
require_creds
resolve_bucket_name
state_load

DIST_ID="$(state_get DISTRIBUTION_ID)"
WAF_ARN="$(state_get WAF_ARN)"

header "전체 삭제"

cat <<EOF
  삭제 대상 (리전 $REGION, 계정 $ACCOUNT_ID)

    CloudFront 배포     ${DIST_ID:-없음}
    WAF Web ACL         $WAF_NAME
    S3 버킷             $BUCKET_NAME  (내용물 전부)
    Lambda 함수         $FUNCTION_NAME
    DynamoDB 테이블     $TABLE_NAME  (모든 데이터)
    SSM 파라미터        $SSM_PREFIX/*  ← API 키가 들어있습니다
    IAM 역할/정책       $ROLE_NAME / $POLICY_NAME
    CloudWatch 로그     /aws/lambda/$FUNCTION_NAME
    CloudWatch 알람     ${PROJECT}-*
    SNS 주제            $SNS_TOPIC_NAME
    AWS Budgets         ${PROJECT}-monthly, ${PROJECT}-bedrock-only

  ${C_YEL}CloudFront 삭제는 비활성화 전파 때문에 15~25분 걸립니다.${C_RST}
EOF

if [ "${FORCE:-0}" != "1" ]; then
  printf '\n  계속하려면 %sdelete%s 를 입력하세요: ' "$C_BLD" "$C_RST"
  read -r ANSWER
  [ "$ANSWER" = "delete" ] || { info "취소했습니다."; exit 0; }
fi

# ────────────────────────────────────────────────────────────
step "1. WAF 연결 해제"
# ────────────────────────────────────────────────────────────
if [ -n "$DIST_ID" ] && aws cloudfront get-distribution --id "$DIST_ID" >/dev/null 2>&1; then
  CUR_ACL="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
    --query 'DistributionConfig.WebACLId' --output text 2>/dev/null || echo "")"
  if [ -n "$CUR_ACL" ] && [ "$CUR_ACL" != "None" ] && [ "$CUR_ACL" != "" ]; then
    TMP="$INFRA_DIR/.cf-del.json"
    ETAG="$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text)"
    aws cloudfront get-distribution-config --id "$DIST_ID" --query 'DistributionConfig' --output json > "$TMP"
    python3 -c "
import json,sys
p='$TMP'; c=json.load(open(p)); c['WebACLId']=''; json.dump(c, open(p,'w'))"
    aws cloudfront update-distribution --id "$DIST_ID" \
      --distribution-config "file://$TMP" --if-match "$ETAG" >/dev/null 2>&1 \
      && ok "WAF 연결 해제" || warn "WAF 연결 해제 실패"
    rm -f "$TMP"
    info "연결 해제 전파 대기 (60초)..."
    sleep 60
  else
    skip "WAF 미연결"
  fi
else
  skip "배포 없음"
fi

# ────────────────────────────────────────────────────────────
step "2. CloudFront 배포 비활성화 → 삭제"
# ────────────────────────────────────────────────────────────
if [ -n "$DIST_ID" ] && aws cloudfront get-distribution --id "$DIST_ID" >/dev/null 2>&1; then
  ENABLED="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
    --query 'DistributionConfig.Enabled' --output text)"
  if [ "$ENABLED" = "True" ] || [ "$ENABLED" = "true" ]; then
    TMP="$INFRA_DIR/.cf-del.json"
    ETAG="$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text)"
    aws cloudfront get-distribution-config --id "$DIST_ID" --query 'DistributionConfig' --output json > "$TMP"
    python3 -c "
import json,sys
p='$TMP'; c=json.load(open(p)); c['Enabled']=False; json.dump(c, open(p,'w'))"
    aws cloudfront update-distribution --id "$DIST_ID" \
      --distribution-config "file://$TMP" --if-match "$ETAG" >/dev/null || warn "비활성화 실패"
    rm -f "$TMP"
    ok "비활성화 요청"
  else
    skip "이미 비활성화됨"
  fi

  info "비활성화 전파 대기 (최대 25분, 30초마다 확인)..."
  for i in $(seq 1 50); do
    ST="$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.Status' --output text 2>/dev/null || echo Gone)"
    [ "$ST" = "Deployed" ] && break
    printf '\r  %s%s ... (%d/50)%s' "$C_DIM" "$ST" "$i" "$C_RST"
    sleep 30
  done
  printf '\r%*s\r' 60 ''

  ETAG="$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text 2>/dev/null || true)"
  if [ -n "$ETAG" ]; then
    aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$ETAG" >/dev/null 2>&1 \
      && ok "배포 $DIST_ID 삭제" \
      || warn "배포 삭제 실패 — 콘솔에서 수동 삭제하세요 (아직 전파 중일 수 있음)"
  fi
else
  skip "배포 없음"
fi

# ────────────────────────────────────────────────────────────
step "3. WAF Web ACL 삭제"
# ────────────────────────────────────────────────────────────
WAF_INFO="$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 \
  --query "WebACLs[?Name=='$WAF_NAME'].{Id:Id,LockToken:LockToken}" --output json 2>/dev/null || echo '[]')"
WAF_ID="$(printf '%s' "$WAF_INFO" | python3 -c 'import json,sys
d=json.load(sys.stdin); print(d[0]["Id"] if d else "")' 2>/dev/null)"
WAF_LOCK="$(printf '%s' "$WAF_INFO" | python3 -c 'import json,sys
d=json.load(sys.stdin); print(d[0]["LockToken"] if d else "")' 2>/dev/null)"

if [ -n "$WAF_ID" ]; then
  aws wafv2 delete-web-acl --name "$WAF_NAME" --scope CLOUDFRONT --region us-east-1 \
    --id "$WAF_ID" --lock-token "$WAF_LOCK" >/dev/null 2>&1 \
    && ok "Web ACL 삭제" \
    || warn "Web ACL 삭제 실패 (배포 삭제가 완전히 끝난 뒤 재시도하세요)"
else
  skip "Web ACL 없음"
fi

# ────────────────────────────────────────────────────────────
step "4. S3 버킷 비우기 → 삭제"
# ────────────────────────────────────────────────────────────
if bucket_exists; then
  aws s3 rm "s3://$BUCKET_NAME" --recursive --only-show-errors >/dev/null 2>&1
  # 버전 관리를 켠 적이 있다면 버전/삭제 마커도 지워야 합니다
  aws s3api list-object-versions --bucket "$BUCKET_NAME" \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null \
    | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("Objects"): json.dump(d, sys.stdout)
' > "$INFRA_DIR/.s3del.json" 2>/dev/null || true
  if [ -s "$INFRA_DIR/.s3del.json" ]; then
    aws s3api delete-objects --bucket "$BUCKET_NAME" \
      --delete "file://$INFRA_DIR/.s3del.json" >/dev/null 2>&1 || true
  fi
  rm -f "$INFRA_DIR/.s3del.json"

  aws s3api delete-bucket --bucket "$BUCKET_NAME" --region "$REGION" >/dev/null 2>&1 \
    && ok "버킷 $BUCKET_NAME 삭제" || warn "버킷 삭제 실패 (객체가 남아있을 수 있음)"
else
  skip "버킷 없음"
fi

# ────────────────────────────────────────────────────────────
step "5. Lambda 함수 삭제"
# ────────────────────────────────────────────────────────────
if lambda_exists; then
  aws lambda delete-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null \
    && ok "함수 삭제 (Function URL·리소스 정책 포함)" || warn "함수 삭제 실패"
else
  skip "함수 없음"
fi

# ────────────────────────────────────────────────────────────
step "6. DynamoDB 테이블 삭제"
# ────────────────────────────────────────────────────────────
if ddb_table_exists; then
  aws dynamodb delete-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null \
    && ok "테이블 삭제" || warn "테이블 삭제 실패"
else
  skip "테이블 없음"
fi

# ────────────────────────────────────────────────────────────
step "7. SSM 파라미터 삭제 (API 키)"
# ────────────────────────────────────────────────────────────
NAMES="$(aws ssm describe-parameters --region "$REGION" \
  --query "Parameters[?starts_with(Name,'$SSM_PREFIX')].Name" --output text 2>/dev/null || true)"
if [ -n "$NAMES" ]; then
  # shellcheck disable=SC2086
  aws ssm delete-parameters --region "$REGION" --names $NAMES >/dev/null 2>&1 \
    && ok "파라미터 삭제: $(printf '%s' "$NAMES" | tr '\t' ' ')" || warn "파라미터 삭제 실패"
  warn "Google Cloud Console과 Hardcover에서도 키를 폐기(revoke)하는 것을 권합니다"
else
  skip "파라미터 없음"
fi

# ────────────────────────────────────────────────────────────
step "8. IAM 역할 → 정책 삭제"
# ────────────────────────────────────────────────────────────
if role_exists; then
  ATTACHED="$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" \
    --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true)"
  for arn in $ATTACHED; do
    aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn "$arn" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "$ROLE_NAME" >/dev/null 2>&1 \
    && ok "역할 삭제" || warn "역할 삭제 실패"
else
  skip "역할 없음"
fi

if policy_exists; then
  PARN="$(policy_arn)"
  for v in $(aws iam list-policy-versions --policy-arn "$PARN" \
      --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text 2>/dev/null); do
    aws iam delete-policy-version --policy-arn "$PARN" --version-id "$v" >/dev/null 2>&1
  done
  aws iam delete-policy --policy-arn "$PARN" >/dev/null 2>&1 \
    && ok "정책 삭제" || warn "정책 삭제 실패"
else
  skip "정책 없음"
fi

# ────────────────────────────────────────────────────────────
step "9. CloudWatch 로그 그룹 삭제"
# ────────────────────────────────────────────────────────────
# Lambda를 지워도 로그 그룹은 남아서 계속 스토리지 요금이 나갑니다. 가장 많이 잊는 항목입니다.
if aws logs delete-log-group --log-group-name "/aws/lambda/$FUNCTION_NAME" \
     --region "$REGION" >/dev/null 2>&1; then
  ok "로그 그룹 삭제"
else
  skip "로그 그룹 없음"
fi

# ────────────────────────────────────────────────────────────
step "10. CloudWatch 알람 삭제"
# ────────────────────────────────────────────────────────────
ALARMS="$(aws cloudwatch describe-alarms --region "$REGION" \
  --alarm-name-prefix "$PROJECT" --query 'MetricAlarms[].AlarmName' --output text 2>/dev/null || true)"
if [ -n "$ALARMS" ]; then
  # shellcheck disable=SC2086
  aws cloudwatch delete-alarms --region "$REGION" --alarm-names $ALARMS >/dev/null 2>&1 \
    && ok "알람 삭제: $(printf '%s' "$ALARMS" | tr '\t' ' ')" || warn "알람 삭제 실패"
else
  skip "알람 없음"
fi

# ────────────────────────────────────────────────────────────
step "11. SNS 주제 삭제"
# ────────────────────────────────────────────────────────────
TARN="$(aws sns list-topics --region "$REGION" \
  --query "Topics[?ends_with(TopicArn,':$SNS_TOPIC_NAME')].TopicArn | [0]" --output text 2>/dev/null || true)"
if [ -n "$TARN" ] && [ "$TARN" != "None" ]; then
  aws sns delete-topic --topic-arn "$TARN" --region "$REGION" >/dev/null 2>&1 \
    && ok "주제 삭제" || warn "주제 삭제 실패"
else
  skip "주제 없음"
fi

# ────────────────────────────────────────────────────────────
step "12. AWS Budgets 삭제"
# ────────────────────────────────────────────────────────────
for b in "${PROJECT}-monthly" "${PROJECT}-bedrock-only"; do
  aws budgets delete-budget --account-id "$ACCOUNT_ID" --budget-name "$b" >/dev/null 2>&1 \
    && ok "예산 $b 삭제" || skip "예산 $b"
done

# ────────────────────────────────────────────────────────────
step "13. 남은 리소스 확인"
# ────────────────────────────────────────────────────────────
LEFT=0
check_gone() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    fail "$label 이 아직 남아 있습니다"; LEFT=$((LEFT+1))
  else
    ok "$label 정리됨"
  fi
}
check_gone "Lambda"    aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION"
check_gone "DynamoDB"  aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION"
check_gone "S3"        aws s3api head-bucket --bucket "$BUCKET_NAME"
check_gone "IAM 역할"  aws iam get-role --role-name "$ROLE_NAME"
[ -n "$DIST_ID" ] && check_gone "CloudFront" aws cloudfront get-distribution --id "$DIST_ID"

mv "$STATE_FILE" "${STATE_FILE}.deleted-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

header "정리 완료"
if [ $LEFT -gt 0 ]; then
  warn "$LEFT 개 리소스가 남아 있습니다. 잠시 후 다시 실행하거나 콘솔에서 확인하세요."
  info "CloudFront는 비활성화 전파가 끝나야 삭제됩니다. 20분 후 재실행하세요."
fi
cat <<EOF

  ${C_YEL}마지막 확인${C_RST}
  AWS 요금은 최대 24시간 지연 반영됩니다.
  ${C_BLD}내일 Cost Explorer를 한 번 더 확인${C_RST}하고, 잔여 요금이 없으면 완전히 끝입니다.

    https://console.aws.amazon.com/costmanagement/home#/cost-explorer

EOF
