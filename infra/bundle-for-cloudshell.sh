#!/usr/bin/env bash
#
# CloudShell 업로드용 번들 생성
#
#   bash infra/bundle-for-cloudshell.sh
#   → bookbot-cloudshell.zip  (약 100KB, node_modules 제외)
#
# 왜 필요한가:
#   로컬 CLI가 MFA 강제 정책에 막혀 있을 때, CloudShell은 콘솔 세션(이미 MFA 인증됨)의
#   자격증명을 그대로 사용합니다. 소스를 올려서 CloudShell에서 배포 스크립트를 실행하면
#   MFA 문제를 우회할 수 있습니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "CloudShell 업로드 번들 생성"

cd "$ROOT_DIR"
OUT="$ROOT_DIR/bookbot-cloudshell.zip"
rm -f "$OUT"

# ★ 번들 표식을 넣습니다.
#
#   왜: CloudShell 에 옛 zip 이 남아 있는데 새 zip 을 올렸다고 착각하면
#   "infra/oneshot.sh: No such file or directory" 처럼 엉뚱한 오류가 납니다.
#   실제로 그 일이 있었습니다. 만든 시각을 파일로 심어 두면 한 줄로 확인됩니다.
BUILD_ID="$(date '+%Y-%m-%d %H:%M:%S %Z')"
cat > "$ROOT_DIR/BUNDLE.txt" <<EOF
BookBot 배포 번들
만든 시각 : $BUILD_ID
원샷 배포 : bash infra/oneshot.sh

확인 방법 (CloudShell):
  cat ~/bookbot/BUNDLE.txt

이 시각이 방금 만든 zip 과 다르면 옛 파일입니다.
  rm -f ~/bookbot-cloudshell.zip
  → Actions > Upload file 로 새로 올리세요.
EOF

# node_modules, 빌드 산출물, 비밀 파일은 제외합니다.
# secrets.env 는 API 키가 들어있어서 제외 — CloudShell에서 다시 만듭니다.
zip -qr "$OUT" \
  backend/src backend/scripts backend/package.json backend/package-lock.json \
  frontend/src frontend/scripts frontend/index.html frontend/vite.config.js \
  frontend/package.json frontend/package-lock.json \
  infra docs README.md BUNDLE.txt \
  -x '*/node_modules/*' \
  -x '*/dist/*' \
  -x '*/.build/*' \
  -x '*.DS_Store' \
  -x 'infra/secrets.env' \
  -x 'infra/.state' \
  -x 'infra/.*' \
  -x 'docs/*.png' \
  -x '*.pptx'
# docs/aws-architecture.png(390KB)·발표 자료(.pptx)는 배포에 쓰지 않는 자료라
# 번들에서 제외합니다. 필요하면 scripts/make-arch-diagram.py 로 다시 만듭니다.

rm -f "$ROOT_DIR/BUNDLE.txt"
[ -f "$OUT" ] || die "번들 생성 실패"
ok "생성: bookbot-cloudshell.zip ($(du -h "$OUT" | cut -f1))"

FILES="$(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
info "파일 $FILES 개"
warn "secrets.env 는 제외했습니다 (API 키 보호). CloudShell에서 새로 만듭니다."

cat <<EOF

${C_BLD}════ CloudShell 배포 — 붙여넣기 2번 ════${C_RST}

${C_BLD}1. 업로드${C_RST}
   AWS 콘솔 우측 상단 터미널 아이콘 (>_) 으로 CloudShell 열기
   리전이 ${C_BLD}$REGION${C_RST} 인지 확인
   ${C_BLD}Actions${C_RST} → ${C_BLD}Upload file${C_RST} → bookbot-cloudshell.zip

${C_BLD}2. 아래 한 줄을 그대로 붙여넣기${C_RST}

${C_GRN}cd ~ && rm -rf bookbot && unzip -oq bookbot-cloudshell.zip -d bookbot && cd bookbot && ls infra/oneshot.sh >/dev/null 2>&1 && bash infra/oneshot.sh || echo "옛 zip 입니다 — rm -f ~/bookbot-cloudshell.zip 후 새로 업로드하세요"${C_RST}

   ${C_DIM}이 한 줄이 전부 합니다:
     Node 확인 → 비밀값 복원 → 백엔드·프론트 배포 → 캐시 무효화
     → 가드레일(WAF·알람) → 검증 → 키 로드 확인 → 확인 목록 출력${C_RST}

${C_BLD}★ API 키는 딱 한 번만 넣습니다 ★${C_RST}
   zip 을 새로 올릴 때마다 다시 입력하지 않습니다. 순서대로 찾습니다.

     1) ${C_BLD}~/keep/secrets.env${C_RST}       CloudShell 홈에 남아 있음 (압축 해제로 안 지워짐)
     2) ${C_BLD}AWS 에서 자동 복원${C_RST}         홈이 초기화됐어도 SSM·Lambda·SNS 에서 되찾음
     3) 둘 다 없으면 서식을 만들고 멈춤 (첫 배포)

   ${C_DIM}한 번 배포하면 도서 API 키는 SSM Parameter Store(SecureString)에,
   모델 ID·연락처는 Lambda 환경변수에, 알림 주소는 SNS 구독에 남습니다.
   그래서 ~/keep 을 잃어도 사용자가 다시 입력할 것이 없습니다.${C_RST}

${C_BLD}첫 배포라면 (키가 AWS 에도 없을 때)${C_RST}
   서식을 만들고 멈춥니다.

     ${C_BLD}nano ~/keep/secrets.env${C_RST}     ${C_DIM}값 채우고 Ctrl+O, Enter, Ctrl+X${C_RST}

   그다음 위 한 줄을 다시 붙여넣으면 끝까지 진행됩니다.

${C_BLD}키를 바꾸거나 추가할 때${C_RST}
     ${C_BLD}nano ~/keep/secrets.env${C_RST}  ${C_DIM}→ 위 한 줄 다시 실행${C_RST}
   ${C_DIM}빈 칸으로 남긴 키는 SSM 의 기존 값을 지우지 않습니다(덮어쓰지 않고 건너뜀).${C_RST}

${C_BLD}옵션${C_RST} ${C_DIM}(필요할 때만)${C_RST}
   ${C_DIM}SKIP_VERIFY=1${C_RST}      배포 후 검증 생략 (빠르게)
   ${C_DIM}SKIP_GUARDRAILS=1${C_RST}  WAF·알람 단계 생략
   ${C_DIM}ONLY=frontend${C_RST}      프론트엔드만 재배포
   예: ${C_DIM}SKIP_VERIFY=1 bash infra/oneshot.sh${C_RST}

${C_BLD}수동으로 단계를 나누고 싶으면${C_RST}
   ${C_DIM}bash infra/update.sh${C_RST}          백엔드 + 프론트 + 캐시 무효화
   ${C_DIM}bash infra/04-guardrails.sh${C_RST}   WAF · 알람 · 예산
   ${C_DIM}bash infra/verify.sh${C_RST}          실제 호출 검증
   ${C_DIM}bash infra/doctor.sh${C_RST}          진단 + 자동 수정

${C_YEL}주의${C_RST}
 · CloudShell 홈 디렉터리는 1GB까지 유지되지만, 120일 미사용 시 삭제됩니다.
 · 배포 후 CloudShell을 닫아도 AWS 리소스는 계속 동작합니다.
 · 2주 뒤 정리:  bash infra/destroy.sh  (CloudShell에서 실행)

EOF
