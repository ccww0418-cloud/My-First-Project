#!/usr/bin/env bash
#
# CloudFront: OAC 2개 → 배포(오리진 2개) → S3 버킷 정책 → Lambda 리소스 정책 → 무효화
#
# 최종 구조:
#   https://xxxx.cloudfront.net/*        → S3 (React)           OAC(s3)     서명
#   https://xxxx.cloudfront.net/api/*    → Lambda Function URL   OAC(lambda) 서명
#
# 이렇게 하면 S3와 Lambda URL 둘 다 비공개로 유지되고, CORS도 필요 없습니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "3/4  CloudFront (단일 진입점)"

require_cli
require_creds
resolve_bucket_name
state_load

# API 오리진 결정 — API Gateway가 있으면 그걸 우선 사용합니다.
#
# 함수 URL은 두 가지 이유로 막힐 수 있습니다:
#   ① AuthType=AWS_IAM + OAC → POST 본문 서명 불가 (AWS 문서 제약)
#   ② AuthType=NONE → Lambda Public Access Block(계정/조직 가드레일)이 403
# 그런 경우 infra/05-apigateway.sh 를 실행하면 API_GW_HOST가 .state에 기록되고,
# 여기서 자동으로 감지해 API Gateway를 오리진으로 씁니다.
API_HOST="$(state_get API_GW_HOST)"
API_KIND="apigateway"
if [ -z "$API_HOST" ]; then
  API_HOST="$(state_get FUNCTION_URL_HOST)"
  API_KIND="lambda-url"
fi
[ -n "$API_HOST" ] || die "API 오리진을 찾을 수 없습니다. bash infra/01-backend.sh 또는 bash infra/05-apigateway.sh 를 먼저 실행하세요."

S3_DOMAIN="${BUCKET_NAME}.s3.${REGION}.amazonaws.com"
info "S3 오리진  : $S3_DOMAIN"
info "API 오리진 : $API_HOST  ($API_KIND)"
[ "$API_KIND" = "lambda-url" ] && warn "함수 URL을 오리진으로 사용합니다. POST가 403이면 bash infra/05-apigateway.sh 로 전환하세요."

# ────────────────────────────────────────────────────────────
step "관리형 정책 ID 조회"
# ────────────────────────────────────────────────────────────
# 하드코딩하지 않고 이름으로 조회합니다 (ID가 바뀌어도 동작하도록)
lookup_cache_policy() {
  aws cloudfront list-cache-policies --type managed \
    --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='$1'].CachePolicy.Id | [0]" \
    --output text 2>/dev/null
}
lookup_origin_request_policy() {
  aws cloudfront list-origin-request-policies --type managed \
    --query "OriginRequestPolicyList.Items[?OriginRequestPolicy.OriginRequestPolicyConfig.Name=='$1'].OriginRequestPolicy.Id | [0]" \
    --output text 2>/dev/null
}
lookup_response_headers_policy() {
  aws cloudfront list-response-headers-policies --type managed \
    --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='$1'].ResponseHeadersPolicy.Id | [0]" \
    --output text 2>/dev/null
}

CACHE_OPTIMIZED="$(lookup_cache_policy 'CachingOptimized')"
CACHE_DISABLED="$(lookup_cache_policy 'CachingDisabled')"
ORP_ALLVIEWER_NOHOST="$(lookup_origin_request_policy 'Managed-AllViewerExceptHostHeader')"
[ "$ORP_ALLVIEWER_NOHOST" = "None" ] && ORP_ALLVIEWER_NOHOST="$(lookup_origin_request_policy 'AllViewerExceptHostHeader')"
RHP_SECURITY="$(lookup_response_headers_policy 'Managed-SecurityHeadersPolicy')"
[ "$RHP_SECURITY" = "None" ] && RHP_SECURITY="$(lookup_response_headers_policy 'SecurityHeadersPolicy')"

# 조회 실패 시 알려진 고정 ID로 폴백
[ -z "$CACHE_OPTIMIZED" ] || [ "$CACHE_OPTIMIZED" = "None" ] && CACHE_OPTIMIZED="658327ea-f89d-4fab-a63d-7e88639e58f6"
[ -z "$CACHE_DISABLED" ] || [ "$CACHE_DISABLED" = "None" ] && CACHE_DISABLED="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
[ -z "$ORP_ALLVIEWER_NOHOST" ] || [ "$ORP_ALLVIEWER_NOHOST" = "None" ] && ORP_ALLVIEWER_NOHOST="b689b0a8-53d0-40ab-baf2-68738e2966ac"
[ -z "$RHP_SECURITY" ] || [ "$RHP_SECURITY" = "None" ] && RHP_SECURITY="67f7725c-6f97-4210-82d7-5512b31e9d03"

ok "CachingOptimized          $CACHE_OPTIMIZED"
ok "CachingDisabled           $CACHE_DISABLED"
ok "AllViewerExceptHostHeader $ORP_ALLVIEWER_NOHOST"
ok "SecurityHeadersPolicy     $RHP_SECURITY"

# ────────────────────────────────────────────────────────────
step "Origin Access Control 2개"
# ────────────────────────────────────────────────────────────
# S3용과 Lambda용은 OriginAccessControlOriginType이 다릅니다.
# 잘못 쓰면 서명 방식이 안 맞아 403이 납니다.
ensure_oac() {
  local name="$1" type="$2"
  local existing
  existing="$(aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='$name'].Id | [0]" --output text 2>/dev/null)"
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    printf '%s' "$existing"; return
  fi
  aws cloudfront create-origin-access-control \
    --origin-access-control-config "Name=$name,Description=BookBot $type OAC,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=$type" \
    --query 'OriginAccessControl.Id' --output text 2>/dev/null
}

OAC_S3="$(ensure_oac "${PROJECT}-s3-oac" "s3")"
[ -n "$OAC_S3" ] && [ "$OAC_S3" != "None" ] || die "S3 OAC 생성 실패"
ok "S3 OAC     $OAC_S3"
state_set OAC_S3 "$OAC_S3"

# ⚠️ Lambda 오리진에는 OAC를 쓰지 않습니다.
#
# AWS 문서(private-content-restricting-access-to-lambda)에 명시된 제약:
#   "If you use PUT or POST methods with your Lambda function URL, your users must
#    compute the SHA256 of the body and include the payload hash value of the request
#    body in the x-amz-content-sha256 header. Lambda doesn't support unsigned payloads."
#
# 즉 본문이 있는 POST는 **뷰어(브라우저)가** 본문 해시를 계산하고 SigV4 서명까지
# 해야 합니다. 공개 웹앱에서는 불가능합니다.
#   GET  /api/health → 본문 없음 → 통과
#   POST /api/chat   → 본문 있음 → 403
#
# 대신 오리진 커스텀 헤더(x-origin-secret)로 인증합니다.
# 이 헤더는 CloudFront가 오리진으로만 보내며 브라우저에 노출되지 않습니다.
info "Lambda 오리진은 OAC 대신 비밀 헤더 인증 사용 (POST 본문 서명 제약 회피)"

ORIGIN_SECRET="$(state_get ORIGIN_SECRET)"
if [ -z "$ORIGIN_SECRET" ]; then
  ORIGIN_SECRET="$(aws ssm get-parameter --region "$REGION" \
    --name "$SSM_PREFIX/ORIGIN_SECRET" --with-decryption \
    --query 'Parameter.Value' --output text 2>/dev/null || true)"
fi
[ -n "$ORIGIN_SECRET" ] || die "오리진 비밀이 없습니다. 먼저 bash infra/01-backend.sh 를 실행하세요."
ok "오리진 비밀 확보 (${#ORIGIN_SECRET}자)"

# ────────────────────────────────────────────────────────────
step "CloudFront Function — SPA 라우팅"
# ────────────────────────────────────────────────────────────
# 기존에는 "403/404 → /index.html (200)" 사용자 정의 오류 응답으로 SPA 라우팅을 처리했는데,
# 이 규칙은 **배포 전체에 적용**되어 API 오류까지 HTML 200으로 바꿔버립니다.
# 그래서 Lambda가 403을 내도 브라우저는 HTML 200을 받고, 원인 파악이 불가능했습니다.
# → 오류 응답 규칙을 없애고, 확장자 없는 경로만 재작성하는 함수로 교체합니다.
CF_FN_NAME="${PROJECT}-spa-router"
CF_FN_CODE="$INFRA_DIR/.spa-router.js"
cat > "$CF_FN_CODE" <<'JS'
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // API 경로는 절대 건드리지 않습니다 (오류가 HTML로 가려지는 것을 방지)
  if (uri.indexOf('/api/') === 0) {
    return request;
  }

  // 파일 확장자가 있으면 실제 파일 요청 (assets/index-xxx.js 등)
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') !== -1) {
    return request;
  }

  // 그 외는 SPA 라우트로 간주하고 index.html 반환
  request.uri = '/index.html';
  return request;
}
JS

CF_FN_ETAG="$(aws cloudfront describe-function --name "$CF_FN_NAME" \
  --query ETag --output text 2>/dev/null || true)"

if [ -n "$CF_FN_ETAG" ] && [ "$CF_FN_ETAG" != "None" ]; then
  CF_FN_ETAG="$(aws cloudfront update-function \
    --name "$CF_FN_NAME" --if-match "$CF_FN_ETAG" \
    --function-config "Comment=BookBot SPA router,Runtime=cloudfront-js-2.0" \
    --function-code "fileb://$CF_FN_CODE" \
    --query ETag --output text)" || die "CloudFront Function 갱신 실패"
  ok "함수 $CF_FN_NAME 갱신"
else
  CF_FN_ETAG="$(aws cloudfront create-function \
    --name "$CF_FN_NAME" \
    --function-config "Comment=BookBot SPA router,Runtime=cloudfront-js-2.0" \
    --function-code "fileb://$CF_FN_CODE" \
    --query ETag --output text)" || die "CloudFront Function 생성 실패"
  ok "함수 $CF_FN_NAME 생성"
fi

# 배포에 연결하려면 반드시 publish 되어 있어야 합니다
aws cloudfront publish-function --name "$CF_FN_NAME" --if-match "$CF_FN_ETAG" >/dev/null \
  && ok "함수 발행(publish)" || warn "함수 발행 실패 (이미 최신일 수 있음)"

CF_FN_ARN="$(aws cloudfront describe-function --name "$CF_FN_NAME" \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)"
[ -n "$CF_FN_ARN" ] && [ "$CF_FN_ARN" != "None" ] || die "함수 ARN을 가져오지 못했습니다"
info "ARN: $CF_FN_ARN"
rm -f "$CF_FN_CODE"

# ────────────────────────────────────────────────────────────
step "배포 설정 생성"
# ────────────────────────────────────────────────────────────
DIST_ID="$(state_get DISTRIBUTION_ID)"

# ★ .state 가 유실되면 기존 배포를 갱신하지 않고 새로 만들어버립니다.
#   실제로 이 일이 발생해서 배포가 2개가 되고, S3 버킷 정책이 새 배포만
#   허용하도록 덮어써져서 옛 배포가 죽었습니다.
#   그래서 .state 에 값이 없으면 AWS에서 직접 찾아봅니다 (Comment로 식별).
if [ -z "$DIST_ID" ]; then
  FOUND="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?contains(Comment,'BookBot')].Id" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d')"
  COUNT="$(printf '%s\n' "$FOUND" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [ "$COUNT" = "1" ]; then
    DIST_ID="$FOUND"
    warn ".state에 배포 ID가 없어 기존 배포를 자동으로 찾았습니다: $DIST_ID"
    state_set DISTRIBUTION_ID "$DIST_ID"
  elif [ "$COUNT" -gt 1 ]; then
    fail "BookBot 배포가 $COUNT 개 있습니다. 어느 것을 갱신할지 알 수 없습니다."
    aws cloudfront list-distributions \
      --query "DistributionList.Items[?contains(Comment,'BookBot')].{Id:Id,Domain:DomainName,Enabled:Enabled}" \
      --output table
    cat <<EOF

  사용할 배포 ID를 .state 에 직접 넣고 다시 실행하세요:
    echo "DISTRIBUTION_ID=<사용할ID>" >> infra/.state

  나머지는 삭제하세요 (요금이 계속 나갑니다):
    docs/04-cost-and-cleanup.md 의 삭제 순서 참고

EOF
    exit 1
  else
    info "기존 BookBot 배포 없음 → 새로 생성합니다"
  fi
fi

CALLER_REF="${PROJECT}-$(date +%s)"

# 기존 배포가 있으면 CallerReference를 유지해야 합니다 (변경 불가 필드)
if [ -n "$DIST_ID" ]; then
  EXISTING_REF="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
    --query 'DistributionConfig.CallerReference' --output text 2>/dev/null || true)"
  [ -n "$EXISTING_REF" ] && [ "$EXISTING_REF" != "None" ] && CALLER_REF="$EXISTING_REF"
fi

# ── 기존 배포에서 보존해야 하는 값 읽기 ─────────────────────
#
# update-distribution 은 create 와 달리 **전체 설정**을 요구합니다.
# 필드를 생략하면 "IllegalUpdate: Aliases are missing for the resource" 같은 오류가 나고,
# 빈 값으로 덮어쓰면 기존 설정(WAF 연결 등)이 조용히 날아갑니다.
# 그래서 우리가 관리하지 않는 필드는 현재 값을 읽어 그대로 넘깁니다.
EXIST_ALIASES='{"Quantity": 0}'
EXIST_WEBACL=''
if [ -n "$DIST_ID" ] && aws cloudfront get-distribution-config --id "$DIST_ID" >/dev/null 2>&1; then
  EXIST_ALIASES="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
    --query 'DistributionConfig.Aliases' --output json 2>/dev/null || echo '{"Quantity": 0}')"
  EXIST_WEBACL="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
    --query 'DistributionConfig.WebACLId' --output text 2>/dev/null || echo '')"
  [ "$EXIST_WEBACL" = "None" ] && EXIST_WEBACL=''
  ALIAS_N="$(printf '%s' "$EXIST_ALIASES" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Quantity",0))' 2>/dev/null || echo 0)"
  info "기존 값 보존: 대체 도메인 ${ALIAS_N}개, WAF $([ -n "$EXIST_WEBACL" ] && echo '연결됨' || echo '없음')"
fi

CONFIG_FILE="$INFRA_DIR/.cf-config.json"

# heredoc을 <<'PY' 로 인용해서 셸 확장을 완전히 차단하고, 값은 환경 변수로 넘깁니다.
# (JSON 생성기 안에서 셸 보간을 쓰면 값에 특수문자가 들어갈 때 조용히 깨집니다)
export CF_CALLER_REF="$CALLER_REF"
export CF_S3_DOMAIN="$S3_DOMAIN"
export CF_LAMBDA_DOMAIN="$API_HOST"
export CF_OAC_S3="$OAC_S3"
export CF_CACHE_OPTIMIZED="$CACHE_OPTIMIZED"
export CF_CACHE_DISABLED="$CACHE_DISABLED"
export CF_ORP="$ORP_ALLVIEWER_NOHOST"
export CF_RHP="$RHP_SECURITY"
export CF_ORIGIN_SECRET="$ORIGIN_SECRET"
export CF_FN_ARN="$CF_FN_ARN"
export CF_ALIASES="$EXIST_ALIASES"
export CF_WEBACL="$EXIST_WEBACL"

python3 - > "$CONFIG_FILE" <<'PY'
import json, os

env = os.environ
required = ['CF_CALLER_REF', 'CF_S3_DOMAIN', 'CF_LAMBDA_DOMAIN', 'CF_OAC_S3',
            'CF_CACHE_OPTIMIZED', 'CF_CACHE_DISABLED', 'CF_ORP', 'CF_RHP',
            'CF_ORIGIN_SECRET', 'CF_FN_ARN']
missing = [k for k in required if not env.get(k)]
if missing:
    raise SystemExit(f'필수 값 누락: {missing}')

try:
    aliases = json.loads(env.get('CF_ALIASES') or '{"Quantity": 0}')
except Exception:
    aliases = {"Quantity": 0}

cfg = {
    "CallerReference": env['CF_CALLER_REF'],
    "Comment": "BookBot - React on S3 + API on Lambda",
    "Enabled": True,
    "DefaultRootObject": "index.html",
    "PriceClass": "PriceClass_200",
    "HttpVersion": "http2and3",
    "IsIPV6Enabled": True,

    # update-distribution 은 전체 설정을 요구합니다. 생략하면
    # "IllegalUpdate: Aliases are missing for the resource" 오류가 납니다.
    "Aliases": aliases,
    "OriginGroups": {"Quantity": 0},

    "Origins": {
        "Quantity": 2,
        "Items": [
            {
                "Id": "s3-web",
                "DomainName": env['CF_S3_DOMAIN'],
                "OriginPath": "",
                "OriginAccessControlId": env['CF_OAC_S3'],
                # OAC를 쓸 때 OriginAccessIdentity는 빈 문자열이어야 합니다 (구식 OAI와 배타적)
                "S3OriginConfig": {"OriginAccessIdentity": ""},
                "CustomHeaders": {"Quantity": 0},
                "ConnectionAttempts": 3,
                "ConnectionTimeout": 10,
            },
            {
                "Id": "lambda-api",
                "DomainName": env['CF_LAMBDA_DOMAIN'],
                "OriginPath": "",
                # OAC 없음 — POST 본문 서명 제약 때문. 대신 아래 비밀 헤더로 인증합니다.
                "CustomOriginConfig": {
                    "HTTPPort": 80,
                    "HTTPSPort": 443,
                    "OriginProtocolPolicy": "https-only",
                    "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
                    # 기본 30초로는 도구를 여러 번 호출할 때 504가 납니다
                    "OriginReadTimeout": 60,
                    "OriginKeepaliveTimeout": 5,
                },
                # 이 헤더는 CloudFront가 오리진으로만 전송합니다. 브라우저에 노출되지 않습니다.
                # Lambda가 값을 검증해서 함수 URL 직접 호출을 차단합니다.
                "CustomHeaders": {
                    "Quantity": 1,
                    "Items": [{
                        "HeaderName": "x-origin-secret",
                        "HeaderValue": env['CF_ORIGIN_SECRET'],
                    }],
                },
                "ConnectionAttempts": 3,
                "ConnectionTimeout": 10,
            },
        ],
    },

    "DefaultCacheBehavior": {
        "TargetOriginId": "s3-web",
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": 2, "Items": ["GET", "HEAD"],
            "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
        },
        "CachePolicyId": env['CF_CACHE_OPTIMIZED'],
        "ResponseHeadersPolicyId": env['CF_RHP'],
        "Compress": True,
        "SmoothStreaming": False,
        "FieldLevelEncryptionId": "",
        "LambdaFunctionAssociations": {"Quantity": 0},
        # SPA 라우팅을 함수로 처리합니다. 사용자 정의 오류 응답을 쓰지 않는 이유는
        # 그 규칙이 배포 전체에 적용되어 API 오류까지 HTML 200으로 바꿔버리기 때문입니다.
        "FunctionAssociations": {
            "Quantity": 1,
            "Items": [{"EventType": "viewer-request", "FunctionARN": env['CF_FN_ARN']}],
        },
    },

    "CacheBehaviors": {
        "Quantity": 1,
        "Items": [{
            "PathPattern": "/api/*",
            "TargetOriginId": "lambda-api",
            "ViewerProtocolPolicy": "redirect-to-https",
            "AllowedMethods": {
                "Quantity": 7,
                "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
                "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
            },
            # 캐싱을 켜두면 모든 사용자가 첫 사람의 답변을 받습니다
            "CachePolicyId": env['CF_CACHE_DISABLED'],
            # Host 헤더를 제외해야 SigV4 서명이 맞습니다. AllViewer를 쓰면 403.
            "OriginRequestPolicyId": env['CF_ORP'],
            # SSE 스트림을 압축하면 버퍼링이 생겨 실시간성이 사라집니다
            "Compress": False,
            "SmoothStreaming": False,
            "FieldLevelEncryptionId": "",
            "LambdaFunctionAssociations": {"Quantity": 0},
            "FunctionAssociations": {"Quantity": 0},
        }],
    },

    # ★ 사용자 정의 오류 응답을 쓰지 않습니다.
    #
    # 원래는 "403/404 → /index.html (200)" 으로 SPA 라우팅을 처리했습니다.
    # 그런데 이 규칙은 동작별로 지정할 수 없고 **배포 전체에 적용**됩니다.
    # 그래서 /api/* 가 403을 반환해도 브라우저는 HTML 200을 받았고,
    # 실제 원인(POST 본문 서명 제약으로 인한 403)을 몇 시간 동안 찾지 못했습니다.
    #
    # SPA 라우팅은 위 CloudFront Function(viewer-request)이 처리합니다.
    # API 오류는 이제 그대로 노출되어 진단이 가능합니다.
    "CustomErrorResponses": {"Quantity": 0},

    "ViewerCertificate": {"CloudFrontDefaultCertificate": True, "MinimumProtocolVersion": "TLSv1.2_2021"},
    "Restrictions": {"GeoRestriction": {"RestrictionType": "none", "Quantity": 0}},
    "Logging": {"Enabled": False, "IncludeCookies": False, "Bucket": "", "Prefix": ""},

    # 기존 WAF 연결을 보존합니다. 빈 값으로 덮어쓰면 04-guardrails.sh 로 붙인
    # Web ACL이 조용히 분리됩니다.
    "WebACLId": env.get('CF_WEBACL') or "",
}

# 자기 검증 — 잘못된 설정이 배포되는 것을 막습니다
api = cfg["CacheBehaviors"]["Items"][0]
assert api["CachePolicyId"] == env['CF_CACHE_DISABLED'], "API 동작은 캐싱을 꺼야 합니다"
assert api["Compress"] is False, "SSE 스트리밍은 압축을 꺼야 합니다"
assert "POST" in api["AllowedMethods"]["Items"], "채팅에는 POST가 필요합니다"
assert cfg["Origins"]["Items"][1]["CustomOriginConfig"]["OriginReadTimeout"] >= 60, "오리진 타임아웃 60초 이상"
assert not env['CF_LAMBDA_DOMAIN'].startswith('http'), "Lambda 오리진은 호스트명만 (https:// 제거)"
assert not env['CF_LAMBDA_DOMAIN'].endswith('/'), "Lambda 오리진 끝의 / 제거"

lam = cfg["Origins"]["Items"][1]
assert "OriginAccessControlId" not in lam, "Lambda 오리진에 OAC를 붙이면 POST 본문이 403이 됩니다"
assert lam["CustomHeaders"]["Quantity"] == 1, "Lambda 오리진에 비밀 헤더가 필요합니다"
assert lam["CustomHeaders"]["Items"][0]["HeaderName"] == "x-origin-secret"
assert len(lam["CustomHeaders"]["Items"][0]["HeaderValue"]) >= 20, "오리진 비밀이 너무 짧습니다"
assert cfg["CustomErrorResponses"]["Quantity"] == 0, "오류 응답 규칙은 API 오류를 가립니다"
assert cfg["DefaultCacheBehavior"]["FunctionAssociations"]["Quantity"] == 1, "SPA 라우팅 함수 필요"

print(json.dumps(cfg, indent=2))
PY
[ -s "$CONFIG_FILE" ] || die "배포 설정 생성 실패"
python3 -c "import json;json.load(open('$CONFIG_FILE'))" || die "생성된 JSON이 잘못되었습니다"
ok "설정 JSON 생성 + 자기 검증 통과"

# ────────────────────────────────────────────────────────────
step "CloudFront 배포"
# ────────────────────────────────────────────────────────────
if [ -n "$DIST_ID" ] && aws cloudfront get-distribution --id "$DIST_ID" >/dev/null 2>&1; then
  ETAG="$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text)"
  aws cloudfront update-distribution \
    --id "$DIST_ID" \
    --distribution-config "file://$CONFIG_FILE" \
    --if-match "$ETAG" >/dev/null || die "배포 업데이트 실패"
  ok "배포 $DIST_ID 업데이트"
else
  CREATE_OUT="$(aws cloudfront create-distribution \
    --distribution-config "file://$CONFIG_FILE" \
    --query '{Id:Distribution.Id,Domain:Distribution.DomainName,Arn:Distribution.ARN}' \
    --output json)" || die "배포 생성 실패"
  DIST_ID="$(printf '%s' "$CREATE_OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Id"])')"
  ok "배포 $DIST_ID 생성"
fi

DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)"
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"

state_set DISTRIBUTION_ID "$DIST_ID"
state_set DISTRIBUTION_DOMAIN "$DIST_DOMAIN"
state_set DISTRIBUTION_ARN "$DIST_ARN"
state_set SITE_URL "https://$DIST_DOMAIN"

info "도메인: https://$DIST_DOMAIN"
rm -f "$CONFIG_FILE"

# ────────────────────────────────────────────────────────────
step "S3 버킷 정책 — 이 배포만 허용"
# ────────────────────────────────────────────────────────────
BUCKET_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipalReadOnly",
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${BUCKET_NAME}/*",
    "Condition": {"StringEquals": {"AWS:SourceArn": "${DIST_ARN}"}}
  }]
}
JSON
)"
aws s3api put-bucket-policy --bucket "$BUCKET_NAME" --policy "$BUCKET_POLICY" >/dev/null \
  && ok "버킷 정책 적용 (SourceArn 조건으로 이 배포만)" \
  || die "버킷 정책 적용 실패"

# ────────────────────────────────────────────────────────────
step "API 오리진 권한 확인"
# ────────────────────────────────────────────────────────────
if [ "$API_KIND" = "apigateway" ]; then
  info "API Gateway 경유 — Lambda 호출 권한은 05-apigateway.sh 에서 설정됩니다"
  ok "오리진 인증: x-origin-secret 헤더 (API Gateway 직접 호출 차단)"
else
  aws lambda add-permission \
    --region "$REGION" --function-name "$FUNCTION_NAME" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl \
    --principal '*' \
    --function-url-auth-type NONE >/dev/null 2>&1 \
    && ok "함수 URL 호출 권한 추가" || info "함수 URL 호출 권한 이미 존재"

  aws lambda remove-permission --region "$REGION" --function-name "$FUNCTION_NAME" \
    --statement-id AllowCloudFrontServicePrincipal >/dev/null 2>&1 \
    && info "구 OAC 정책문 제거" || true
fi

info "Lambda가 x-origin-secret 헤더를 검증하므로 CloudFront 경유만 통과합니다."

# ────────────────────────────────────────────────────────────
step "캐시 무효화"
# ────────────────────────────────────────────────────────────
INV_ID="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' \
  --query 'Invalidation.Id' --output text 2>/dev/null || true)"
[ -n "$INV_ID" ] && ok "무효화 $INV_ID" || warn "무효화 실패 (배포 직후면 불필요)"

printf '\n'
ok "CloudFront 완료"
warn "배포 전파에 5~15분 걸립니다. 지금 접속하면 아직 안 될 수 있습니다."
info "상태 확인: aws cloudfront get-distribution --id $DIST_ID --query 'Distribution.Status' --output text"
