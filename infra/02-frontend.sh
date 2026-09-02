#!/usr/bin/env bash
#
# 프론트엔드: S3 버킷 생성(완전 비공개) → Vite 빌드 → 업로드
#
# 버킷은 퍼블릭 액세스를 전면 차단합니다. CloudFront OAC로만 접근합니다.
# 버킷 정책은 CloudFront 배포 ARN이 필요하므로 03-cloudfront.sh 에서 붙입니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "2/4  프론트엔드 (S3 · 빌드 · 업로드)"

require_cli
require_creds
resolve_bucket_name
state_load

# ────────────────────────────────────────────────────────────
step "S3 버킷 — 비공개"
# ────────────────────────────────────────────────────────────
if bucket_exists; then
  skip "버킷 $BUCKET_NAME"
else
  # us-east-1은 LocationConstraint를 주면 오히려 에러가 납니다 (AWS의 오래된 예외)
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region us-east-1 >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  [ $? -eq 0 ] || die "버킷 생성 실패 (이름이 이미 사용 중일 수 있습니다)"
  ok "버킷 $BUCKET_NAME 생성"
fi

# 퍼블릭 액세스 전면 차단 (기본값이지만 명시적으로 보장)
aws s3api put-public-access-block --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
  >/dev/null && ok "퍼블릭 액세스 전면 차단"

# OAC를 쓰려면 객체 소유권이 BucketOwnerEnforced(ACL 비활성)여야 합니다
aws s3api put-bucket-ownership-controls --bucket "$BUCKET_NAME" \
  --ownership-controls "Rules=[{ObjectOwnership=BucketOwnerEnforced}]" \
  >/dev/null 2>&1 && ok "객체 소유권: BucketOwnerEnforced (ACL 비활성)"

# 기본 암호화
aws s3api put-bucket-encryption --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' \
  >/dev/null 2>&1 && ok "기본 암호화 SSE-S3"

# ────────────────────────────────────────────────────────────
step "프론트엔드 빌드"
# ────────────────────────────────────────────────────────────
cd "$FRONTEND_DIR"

if [ ! -d node_modules ]; then
  info "의존성 설치..."
  npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install 실패"
fi

# VITE_API_BASE를 비워둡니다 → 프론트가 같은 도메인의 /api 를 상대 경로로 호출
# (CloudFront 단일 오리진이므로 CORS 불필요)
rm -f .env.production
printf 'VITE_API_BASE=\n' > .env.production

npm run build >/dev/null 2>&1 || die "빌드 실패 — cd frontend && npm run build 로 확인하세요"
[ -f dist/index.html ] || die "dist/index.html이 없습니다"
ok "빌드 완료 ($(du -sh dist | cut -f1))"

# ────────────────────────────────────────────────────────────
step "S3 업로드 — 캐시 헤더 분리"
# ────────────────────────────────────────────────────────────
# assets/ 는 파일명에 해시가 붙으므로 영구 캐싱해도 안전합니다.
# index.html은 캐싱하면 배포가 반영되지 않으므로 no-cache.
aws s3 sync dist/ "s3://$BUCKET_NAME/" \
  --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html" \
  --only-show-errors || die "업로드 실패"

aws s3 cp dist/index.html "s3://$BUCKET_NAME/index.html" \
  --cache-control "no-cache,must-revalidate" \
  --content-type "text/html; charset=utf-8" \
  --only-show-errors || die "index.html 업로드 실패"

OBJ_COUNT="$(aws s3 ls "s3://$BUCKET_NAME/" --recursive | wc -l | tr -d ' ')"
ok "업로드 완료 (객체 $OBJ_COUNT 개)"
info "assets/*   → max-age=31536000, immutable"
info "index.html → no-cache"

cd "$ROOT_DIR"
printf '\n'
ok "프론트엔드 완료"
