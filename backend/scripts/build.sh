#!/usr/bin/env bash
#
# Lambda 배포용 zip 패키징
#
# 사용법:
#   cd backend && bash scripts/build.sh
#   -> backend/dist/bookbot-backend.zip 생성
#
# 이 zip을 Lambda 콘솔 > 코드 > "업로드 원본" > ".zip 파일" 로 올립니다.
# (콘솔 직접 업로드 한도는 50MB. 넘으면 S3에 올려서 "Amazon S3 위치" 옵션 사용)
#
# 왜 의존성을 zip에 포함하는가:
#   Lambda Node.js 런타임에 AWS SDK v3가 들어있긴 하지만, 어떤 클라이언트가
#   포함되는지는 런타임 버전에 따라 다르고 보장되지 않습니다.
#   @aws-sdk/client-bedrock-runtime 같은 최신 클라이언트는 없을 수 있습니다.
#   런타임 업데이트로 갑자기 깨지는 걸 막기 위해 명시적으로 번들링합니다.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BUILD_DIR="$ROOT/.build"
DIST_DIR="$ROOT/dist"
ZIP_NAME="bookbot-backend.zip"

echo "==> 이전 빌드 정리"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"
rm -f "$DIST_DIR/$ZIP_NAME"

echo "==> 소스 복사"
cp -R src "$BUILD_DIR/"
cp package.json "$BUILD_DIR/"
[ -f package-lock.json ] && cp package-lock.json "$BUILD_DIR/"

echo "==> 프로덕션 의존성 설치"
cd "$BUILD_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

echo "==> 불필요한 파일 제거 (zip 크기 축소)"
find node_modules -type d \( \
  -name 'test' -o -name 'tests' -o -name '__tests__' -o -name 'docs' -o -name 'example' -o -name 'examples' \
  \) -prune -exec rm -rf {} + 2>/dev/null || true
find node_modules -type f \( \
  -name '*.md' -o -name '*.ts' -o -name '*.map' -o -name '.npmignore' -o -name 'LICENSE*' -o -name '*.flow' \
  \) -delete 2>/dev/null || true

echo "==> zip 생성"
zip -qr "$DIST_DIR/$ZIP_NAME" . -x '*.DS_Store' -x '.git/*'

cd "$ROOT"
SIZE=$(du -h "$DIST_DIR/$ZIP_NAME" | cut -f1)

cat <<EOF

빌드 완료
  파일: dist/$ZIP_NAME  ($SIZE)

Lambda 콘솔 설정값:
  런타임    Node.js 22.x
  아키텍처  arm64
  핸들러    src/index.handler        <- 스트리밍(권장)
            src/index.bufferedHandler <- API Gateway 사용 시
  메모리    1024 MB
  타임아웃   90 초

AWS CLI로 배포하려면 (이 프로젝트는 us-east-1 입니다):
  aws lambda update-function-code \\
    --function-name bookbot-api \\
    --zip-file fileb://dist/$ZIP_NAME \\
    --region us-east-1
보통은 이 명령을 직접 치지 않습니다. CloudShell에서:
  bash infra/update.sh
EOF
