#!/usr/bin/env bash
#
# AWS CLI 자격증명 진단 도우미
#
#   bash infra/setup-credentials.sh
#
# 현재 상태를 진단하고, 상황에 맞는 설정 방법을 알려줍니다.
# 실제 자격증명 입력은 대화형이라 이 스크립트가 대신할 수 없습니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

header "AWS CLI 자격증명 진단"

command -v aws >/dev/null 2>&1 || die "AWS CLI가 없습니다.  brew install awscli"
ok "AWS CLI $(aws --version 2>&1 | cut -d' ' -f1 | cut -d/ -f2)"

# ── 이미 되는지 확인 ────────────────────────────────────────
step "현재 상태"
if OUT="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
  ACCT="$(printf '%s' "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Account"])')"
  ARN="$(printf '%s' "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Arn"])')"
  ok "자격증명 정상"
  info "계정 : $ACCT"
  info "주체 : $ARN"
  printf '\n  준비 완료. 다음 단계:\n    %sbash infra/00-preflight.sh%s\n\n' "$C_BLD" "$C_RST"
  exit 0
fi

fail "AWS 자격증명을 찾을 수 없습니다"

# ── 무엇이 있고 무엇이 없는지 ───────────────────────────────
step "찾은 것"
HAS_ANY=0

if [ -f ~/.aws/credentials ]; then
  ok "~/.aws/credentials 존재 (프로필: $(grep -o '^\[.*\]' ~/.aws/credentials 2>/dev/null | tr -d '[]' | tr '\n' ' '))"
  HAS_ANY=1
else
  info "~/.aws/credentials 없음"
fi

if [ -f ~/.aws/config ]; then
  ok "~/.aws/config 존재"
  grep -E '^\[|^region|^sso_start_url|^sso_session' ~/.aws/config 2>/dev/null | sed 's/^/      /'
  HAS_ANY=1
else
  info "~/.aws/config 없음"
fi

if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  ok "환경 변수 AWS_ACCESS_KEY_ID 설정됨"
  HAS_ANY=1
fi

# Kiro IDE 토큰을 AWS 자격증명으로 오해하는 경우가 흔합니다
if [ -f ~/.aws/sso/cache/kiro-auth-token.json ]; then
  warn "~/.aws/sso/cache/kiro-auth-token.json 발견"
  cat <<EOF
      이것은 ${C_BLD}Kiro IDE 로그인 토큰${C_RST}입니다.
      AWS 계정에 리소스를 만들 수 있는 자격증명이 ${C_BLD}아닙니다.${C_RST}
      (용도와 스코프가 다릅니다 — sts:GetCallerIdentity 가 동작하지 않습니다)
      AWS CLI용 자격증명을 아래 방법으로 따로 설정해야 합니다.
EOF
fi

# ── 해결 방법 ───────────────────────────────────────────────
header "설정 방법 — 하나만 고르세요"

cat <<EOF
${C_BLD}방법 1. IAM 사용자 액세스 키 (가장 간단, 개인 계정에 권장)${C_RST}

  1) 콘솔에서 액세스 키 발급
     https://console.aws.amazon.com/iam/home#/users
     → 본인 사용자 클릭 → ${C_BLD}보안 자격 증명${C_RST} 탭
     → ${C_BLD}액세스 키 만들기${C_RST} → 사용 사례 ${C_BLD}Command Line Interface (CLI)${C_RST}
     → 확인란 체크 → 다음 → 만들기
     → ${C_YEL}이 화면에서만 시크릿 키를 볼 수 있습니다. 지금 복사하세요.${C_RST}

  2) 터미널에서 설정
     ${C_BLD}aws configure${C_RST}
       AWS Access Key ID     : AKIA...
       AWS Secret Access Key : ****
       Default region name   : ${C_BLD}us-east-1${C_RST}
       Default output format : json

${C_BLD}방법 2. IAM Identity Center / SSO (회사 계정을 쓰는 경우)${C_RST}

  ${C_BLD}aws configure sso${C_RST}
    SSO session name  : bookbot
    SSO start URL     : https://<조직>.awsapps.com/start
    SSO region        : us-east-1
    → 브라우저가 열리면 승인
    → 계정/역할 선택
    CLI default region: us-east-1

  이후 세션이 만료되면:  ${C_BLD}aws sso login --profile <프로필명>${C_RST}
  프로필을 기본으로 쓰려면:  ${C_BLD}export AWS_PROFILE=<프로필명>${C_RST}

${C_BLD}방법 3. 임시 자격증명 (짧게 테스트만 할 때)${C_RST}

  export AWS_ACCESS_KEY_ID=...
  export AWS_SECRET_ACCESS_KEY=...
  export AWS_SESSION_TOKEN=...      # STS 임시 자격증명인 경우
  export AWS_DEFAULT_REGION=us-east-1

${C_DIM}────────────────────────────────────────────────────────────${C_RST}

  설정 후 확인:
    ${C_BLD}aws sts get-caller-identity${C_RST}
    ${C_BLD}bash infra/setup-credentials.sh${C_RST}   ← 이 스크립트 재실행

  ${C_YEL}보안 주의${C_RST}
  액세스 키를 채팅창이나 코드에 붙여넣지 마세요.
  ${C_BLD}aws configure${C_RST} 로 직접 입력하면 ~/.aws/credentials 에 안전하게 저장됩니다.

EOF

exit 1
