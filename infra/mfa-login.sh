#!/usr/bin/env bash
#
# MFA 세션 발급 — MFA 강제 정책이 걸린 계정에서 CLI를 쓰기 위한 스크립트
#
#   bash infra/mfa-login.sh 123456        # 인증 앱의 6자리 코드
#
# 하는 일:
#   1) 내 MFA 디바이스 중 TOTP(virtual MFA) 디바이스를 찾음
#   2) sts:GetSessionToken 으로 MFA 인증된 임시 자격증명 발급 (기본 12시간)
#   3) ~/.aws/credentials 의 [bookbot-mfa] 프로필에 저장
#   4) config.sh 가 이 프로필을 자동으로 감지해서 모든 스크립트가 사용
#
# ⚠️ FIDO 보안 키(u2f)만 등록되어 있으면 이 방법을 쓸 수 없습니다.
#    FIDO는 6자리 코드를 만들지 않고, AWS CLI는 WebAuthn을 지원하지 않습니다.
#    → 인증 앱(TOTP) MFA를 추가로 등록하세요. 아래 안내 참고.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

PROFILE_NAME="bookbot-mfa"
DURATION="${DURATION:-43200}"   # 12시간 (IAM 사용자 최대 36시간)

header "MFA 세션 발급"

command -v aws >/dev/null 2>&1 || die "AWS CLI가 없습니다"

# 기본(장기) 자격증명으로 호출해야 합니다. 기존 MFA 프로필이 만료됐을 수 있으므로 명시적으로 해제.
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

USER_ARN="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)" \
  || die "자격증명이 없습니다. 먼저 aws configure 를 실행하세요."
USER_NAME="${USER_ARN##*/}"
ok "사용자 $USER_NAME"

# ────────────────────────────────────────────────────────────
step "MFA 디바이스 조회"
# ────────────────────────────────────────────────────────────
DEVICES="$(aws iam list-mfa-devices --user-name "$USER_NAME" \
  --query 'MFADevices[].SerialNumber' --output text 2>/dev/null || true)"

if [ -z "$DEVICES" ]; then
  die "MFA 디바이스가 없습니다. 콘솔에서 MFA를 등록하세요."
fi

TOTP_SERIAL=""
U2F_SERIAL=""
for d in $DEVICES; do
  case "$d" in
    *:mfa/*) TOTP_SERIAL="$d"; info "TOTP(인증 앱) : $d" ;;
    *:u2f/*) U2F_SERIAL="$d";  info "FIDO 보안 키  : $d" ;;
    *)       info "기타          : $d" ;;
  esac
done

if [ -z "$TOTP_SERIAL" ]; then
  fail "TOTP(인증 앱) MFA 디바이스가 없습니다"
  cat <<EOF

  등록된 것은 ${C_BLD}FIDO 보안 키(u2f)${C_RST}뿐입니다.
  FIDO는 6자리 코드를 생성하지 않고, AWS CLI는 WebAuthn을 지원하지 않습니다.
  따라서 ${C_BLD}CLI로는 MFA 세션을 받을 수 없습니다.${C_RST}

  ${C_BLD}해결: 인증 앱(TOTP) MFA를 하나 더 추가하세요${C_RST}
  IAM 사용자는 MFA 디바이스를 최대 8개까지 등록할 수 있습니다.
  기존 FIDO 키를 지우지 않아도 됩니다.

    1) 콘솔 로그인 (기존 보안 키로)
       https://console.aws.amazon.com/iam/home#/users/$USER_NAME?section=security_credentials

    2) "다중 인증(MFA)" 섹션 → ${C_BLD}MFA 디바이스 할당${C_RST}
    3) 디바이스 이름: ${C_BLD}cli-totp${C_RST}
       MFA 디바이스 종류: ${C_BLD}인증 관리자 앱${C_RST} (Authenticator app)
    4) QR 코드를 스마트폰 앱으로 스캔
       (Google Authenticator / Microsoft Authenticator / Authy / 1Password 등)
    5) 연속된 코드 2개 입력 → MFA 추가

    6) 다시 실행:
       ${C_BLD}bash infra/mfa-login.sh <6자리코드>${C_RST}

  ${C_YEL}교육 계정이라 MFA 추가가 막혀 있을 수도 있습니다.${C_RST}
  그렇다면 CLI 배포는 불가능하고, 아래 두 가지 대안이 있습니다:

    A) ${C_BLD}AWS CloudShell${C_RST} — 콘솔 우측 상단 터미널 아이콘
       콘솔 세션(이미 MFA 인증됨)의 자격증명을 그대로 씁니다.
       이 저장소를 올리고 CloudShell에서 bash infra/go.sh 실행

    B) ${C_BLD}콘솔 수동 배포${C_RST} — docs/02-aws-console-setup.md (STEP 0~14)

EOF
  exit 1
fi

# ────────────────────────────────────────────────────────────
step "임시 자격증명 발급"
# ────────────────────────────────────────────────────────────
TOKEN_CODE="${1:-}"
if [ -z "$TOKEN_CODE" ]; then
  printf '  인증 앱의 6자리 코드를 입력하세요: '
  read -r TOKEN_CODE
fi

case "$TOKEN_CODE" in
  [0-9][0-9][0-9][0-9][0-9][0-9]) : ;;
  *) die "6자리 숫자를 입력하세요 (받은 값: '$TOKEN_CODE')" ;;
esac

CREDS="$(aws sts get-session-token \
  --serial-number "$TOTP_SERIAL" \
  --token-code "$TOKEN_CODE" \
  --duration-seconds "$DURATION" \
  --output json 2>"$INFRA_DIR/.mfa-err")" || {
    fail "발급 실패:"
    sed 's/^/      /' "$INFRA_DIR/.mfa-err" | head -4
    rm -f "$INFRA_DIR/.mfa-err"
    info "코드가 이미 사용되었거나 시간이 지났을 수 있습니다. 새 코드로 다시 시도하세요."
    exit 1
  }
rm -f "$INFRA_DIR/.mfa-err"

# ────────────────────────────────────────────────────────────
step "프로필 저장"
# ────────────────────────────────────────────────────────────
python3 - "$CREDS" "$PROFILE_NAME" "$REGION" "$INFRA_DIR/.mfa-expiry" <<'PY'
import configparser, json, os, sys

creds = json.loads(sys.argv[1])["Credentials"]
profile, region, expiry_file = sys.argv[2], sys.argv[3], sys.argv[4]

path = os.path.expanduser("~/.aws/credentials")
os.makedirs(os.path.dirname(path), exist_ok=True)

cp = configparser.RawConfigParser()
if os.path.exists(path):
    cp.read(path)
if not cp.has_section(profile):
    cp.add_section(profile)
cp.set(profile, "aws_access_key_id", creds["AccessKeyId"])
cp.set(profile, "aws_secret_access_key", creds["SecretAccessKey"])
cp.set(profile, "aws_session_token", creds["SessionToken"])
cp.set(profile, "region", region)

with open(path, "w") as f:
    cp.write(f)
os.chmod(path, 0o600)

exp = creds["Expiration"]
exp = exp if isinstance(exp, str) else exp.isoformat()
with open(expiry_file, "w") as f:
    f.write(exp + "\n")
print(f"  만료: {exp}")
PY

ok "프로필 [$PROFILE_NAME] 저장 (~/.aws/credentials)"

# ────────────────────────────────────────────────────────────
step "권한 확인"
# ────────────────────────────────────────────────────────────
export AWS_PROFILE="$PROFILE_NAME"
PASS=0; FAILED=0
probe() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; PASS=$((PASS+1))
  else fail "$label"; FAILED=$((FAILED+1)); fi
}
probe "IAM"       aws iam list-roles --max-items 1
probe "Lambda"    aws lambda list-functions --max-items 1 --region "$REGION"
probe "DynamoDB"  aws dynamodb list-tables --max-items 1 --region "$REGION"
probe "S3"        aws s3api list-buckets
probe "Bedrock"   aws bedrock list-foundation-models --region "$BEDROCK_REGION"

printf '\n'
if [ $FAILED -eq 0 ]; then
  ok "모든 권한 확인 — MFA 세션 활성"
  printf '\n  다음: %sbash infra/go.sh%s\n' "$C_BLD" "$C_RST"
  printf '  %s(config.sh가 이 프로필을 자동으로 사용합니다)%s\n\n' "$C_DIM" "$C_RST"
else
  warn "$FAILED 개 서비스가 여전히 거부됩니다"
  info "MFA와 무관한 별도 제한일 수 있습니다 (교육 계정의 서비스 제한 등)"
  info "Bedrock이 거부되면 이 프로젝트를 진행할 수 없습니다 — 교육 담당자에게 문의하세요"
  printf '\n'
fi
