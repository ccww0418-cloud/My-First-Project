#!/usr/bin/env bash
# ============================================================
#  원샷 배포 — 붙여넣기 한 번으로 끝
#
#  CloudShell 에서:
#    cd ~ && rm -rf bookbot && unzip -oq bookbot-cloudshell.zip -d bookbot \
#      && cd bookbot && bash infra/oneshot.sh
#
#  이 스크립트가 순서대로 다 합니다.
#    Node 버전 확인 → 비밀값 복원 → 백엔드·프론트 배포 → 캐시 무효화
#    → 가드레일 → 검증 → 확인 목록 출력
#
#  ★ 비밀값은 항상 ~/keep/secrets.env 에 둡니다 ★
#    저장소 안(infra/secrets.env)에 두면 다음 배포 때 압축을 다시 풀면서
#    사라집니다. 실제로 그렇게 키를 한 번 잃었습니다.
#    이 스크립트는 ~/keep 을 원본으로 보고 저장소 쪽으로 복사합니다.
#    그래서 위 명령을 몇 번 다시 실행해도 안전합니다.
#
#  옵션
#    SKIP_GUARDRAILS=1  WAF·알람 단계 건너뛰기
#    SKIP_VERIFY=1      배포 후 검증 건너뛰기 (빠르게)
#    ONLY=backend       백엔드만 (ONLY=frontend 도 가능)
# ============================================================
set -uo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$INFRA_DIR/config.sh"

KEEP_DIR="$HOME/keep"
KEEP_FILE="$KEEP_DIR/secrets.env"
START=$(date +%s)

# ────────────────────────────────────────────────────────────
#  AWS 에서 비밀값 되찾기
# ────────────────────────────────────────────────────────────
# 왜 필요한가:
#   "zip 을 새로 올릴 때마다 API 키를 다시 넣어야 하나?" — 아닙니다.
#   이미 한 번 배포했다면 키는 전부 AWS 에 있습니다.
#     · 도서 API 키 → SSM Parameter Store (SecureString)
#     · 모델 ID·연락처 → Lambda 환경변수
#     · 알림 이메일 → SNS 구독
#   CloudShell 홈이 초기화되어 ~/keep 이 사라져도 여기서 복원하면
#   사용자는 아무것도 다시 입력하지 않습니다.
#
# 반환: 0 = 복원 성공(모델 ID 확보), 1 = 복원할 것이 없음(첫 배포)
restore_secrets_from_aws() {
  local ssm_json model contact alert
  ssm_json="$(aws ssm get-parameters-by-path --region "$REGION" \
    --path "$SSM_PREFIX" --recursive --with-decryption \
    --query 'Parameters[].[Name,Value]' --output json 2>/dev/null || echo '[]')"

  model="$(aws lambda get-function-configuration --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --query 'Environment.Variables.BEDROCK_MODEL_ID' --output text 2>/dev/null || true)"
  [ "$model" = "None" ] && model=""

  contact="$(aws lambda get-function-configuration --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --query 'Environment.Variables.CONTACT_EMAIL' --output text 2>/dev/null || true)"
  [ "$contact" = "None" ] && contact=""
  # 01-backend.sh 가 비었을 때 넣는 자리표시자는 되살리지 않습니다
  [ "$contact" = "bookbot@example.com" ] && contact=""

  # 알림 이메일은 SNS 구독에만 남습니다
  local topic_arn
  topic_arn="$(aws sns create-topic --name "$SNS_TOPIC_NAME" --region "$REGION" \
    --query TopicArn --output text 2>/dev/null || true)"
  if [ -n "$topic_arn" ] && [ "$topic_arn" != "None" ]; then
    alert="$(aws sns list-subscriptions-by-topic --topic-arn "$topic_arn" --region "$REGION" \
      --query 'Subscriptions[?Protocol==`email`].Endpoint | [0]' --output text 2>/dev/null || true)"
    [ "$alert" = "None" ] && alert=""
  fi

  # 모델 ID 가 없으면 배포한 적이 없는 것입니다 → 복원 불가
  [ -n "$model" ] || return 1

  # SSM 값은 환경변수로 넘깁니다 — 인자로 넘기면 키가 프로세스 목록(ps)에 보입니다
  SSM_JSON="$ssm_json" python3 - "$KEEP_FILE" "$model" "${contact:-}" "${alert:-}" <<'PY'
import json, sys, os

keep, model, contact, alert = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
raw = os.environ.get('SSM_JSON', '[]')
try:
    pairs = json.loads(raw)
except Exception:
    pairs = []

# /bookbot/prod/ALADIN_TTB_KEY → ALADIN_TTB_KEY
vals = {}
for item in pairs:
    if isinstance(item, list) and len(item) == 2 and item[0]:
        vals[item[0].rsplit('/', 1)[-1]] = item[1] or ''

def g(k):
    return vals.get(k, '')

lines = [
    '# BookBot 비밀값 — AWS(SSM · Lambda · SNS)에서 자동 복원했습니다',
    '# 이 파일은 ~/keep 에 있어야 합니다 (압축 해제로 지워지지 않게)',
    f'BEDROCK_MODEL_ID={model}',
    f'ALADIN_TTB_KEY={g("ALADIN_TTB_KEY")}',
    f'NLK_API_KEY={g("NLK_API_KEY")}',
    f'HARDCOVER_TOKEN={g("HARDCOVER_TOKEN")}',
    f'GOOGLE_BOOKS_API_KEY={g("GOOGLE_BOOKS_API_KEY")}',
    f'ALERT_EMAIL={alert}',
    f'CONTACT_EMAIL={contact}',
    '',
]
with open(keep, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

found = [k for k in ('ALADIN_TTB_KEY', 'NLK_API_KEY', 'HARDCOVER_TOKEN', 'GOOGLE_BOOKS_API_KEY') if g(k)]
print(f'  복원: 모델 ID + 도서 API 키 {len(found)}개 {found}')
PY
  return 0
}

header "원샷 배포"

# 어느 번들을 돌리는지 먼저 밝힙니다.
# 옛 zip 이 CloudShell 에 남아 있는데 새로 올렸다고 착각하면
# 원인을 찾기 어려운 오류가 납니다. 실제로 그 일이 있었습니다.
if [ -f "$INFRA_DIR/../BUNDLE.txt" ]; then
  info "$(grep '만든 시각' "$INFRA_DIR/../BUNDLE.txt" | sed 's/만든 시각 : /번들 /')"
fi

require_cli
require_creds
info "계정 $ACCOUNT_ID · 리전 $REGION"

# ────────────────────────────────────────────────────────────
step "1/6  Node.js"
# ────────────────────────────────────────────────────────────
# CloudShell 기본 Node 가 22 미만이면 프론트 빌드(Vite 6)가 실패합니다.
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
fi

if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
  ok "node $(node -v)"
else
  warn "node 22 이상이 필요합니다 (현재: ${NODE_MAJOR:-없음})"
  info "nvm 으로 설치합니다..."
  if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
    curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1
  fi
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm install 22 >/dev/null 2>&1 && nvm use 22 >/dev/null 2>&1
  if command -v node >/dev/null 2>&1 && [ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" -ge 22 ]; then
    ok "node $(node -v) 설치"
  else
    die "Node 22 설치 실패. 수동으로 설치하고 다시 실행하세요."
  fi
fi

# ────────────────────────────────────────────────────────────
step "2/6  비밀값"
# ────────────────────────────────────────────────────────────
mkdir -p "$KEEP_DIR"

if [ -s "$KEEP_FILE" ]; then
  cp "$KEEP_FILE" "$SECRETS_FILE" || die "secrets.env 복사 실패"
  ok "~/keep/secrets.env → infra/secrets.env"
elif [ -s "$SECRETS_FILE" ]; then
  # 사용자가 저장소 쪽에 직접 만든 경우 — 다음 배포를 위해 ~/keep 으로 옮겨둡니다
  cp "$SECRETS_FILE" "$KEEP_FILE" || die "백업 실패"
  ok "infra/secrets.env → ~/keep/secrets.env 로 백업"
elif restore_secrets_from_aws; then
  # ★ ~/keep 을 잃어도 키를 다시 입력할 필요가 없습니다.
  #   이미 배포한 적이 있으면 키가 SSM Parameter Store(SecureString)에 있고,
  #   모델 ID 는 Lambda 환경변수에 있습니다. 거기서 되찾아옵니다.
  ok "AWS(SSM · Lambda)에서 비밀값을 복원했습니다"
  cp "$KEEP_FILE" "$SECRETS_FILE" || die "secrets.env 복사 실패"
  info "~/keep/secrets.env 로 백업했습니다 — 다음부터는 이 파일을 씁니다"
else
  # 처음 실행 — 서식을 ~/keep 에 만들고 멈춥니다.
  # 저장소 쪽에 만들면 다음 실행 때 압축을 다시 풀면서 사라집니다.
  cat > "$KEEP_FILE" <<'ENVEOF'
# BookBot 비밀값 — 이 파일은 ~/keep 에 있어야 합니다 (압축 해제로 지워지지 않게)
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6

# 국내 도서 — 한국 책 검색의 유일한 실질 소스입니다
# 발급: https://www.aladin.co.kr/ttb/wblog_manage.aspx
ALADIN_TTB_KEY=

# 국내 서지 — 절판·구간·학술서까지. 알라딘과 보완 관계입니다
# 발급: https://www.nl.go.kr/NL/contents/N31101030700.do
NLK_API_KEY=

# 무드·평점·내용주의 — 비우면 "위로되는 책" 같은 추천의 근거가 사라집니다
# 발급: https://hardcover.app/account/api
HARDCOVER_TOKEN=

# 커버리지 보강. 비우면 익명 쿼터가 소진돼 사실상 동작하지 않습니다
GOOGLE_BOOKS_API_KEY=

# 장애 알림 받을 주소 (넣으면 확인 메일의 링크를 눌러야 함)
ALERT_EMAIL=

# Open Library 가 User-Agent 에 연락처를 요구합니다
CONTACT_EMAIL=
ENVEOF
  fail "비밀값 파일이 없어서 서식을 만들었습니다"
  cat <<EOF

  ${C_BLD}이것만 하시면 됩니다${C_RST}

    nano ~/keep/secrets.env        ${C_DIM}← 값 채우고 Ctrl+O, Enter, Ctrl+X${C_RST}

  그다음 아래를 그대로 다시 붙여넣으세요. ${C_DIM}(여러 번 실행해도 안전합니다)${C_RST}

    ${C_BLD}cd ~ && rm -rf bookbot && unzip -oq bookbot-cloudshell.zip -d bookbot && cd bookbot && bash infra/oneshot.sh${C_RST}

EOF
  exit 2
fi

# 모델 ID 가 비면 채팅이 반드시 실패합니다. 여기서 미리 잡습니다.
# shellcheck disable=SC1090
set -a; source "$SECRETS_FILE"; set +a
if [ -z "${BEDROCK_MODEL_ID:-}" ]; then
  fail "BEDROCK_MODEL_ID 가 비어 있습니다"
  info "nano ~/keep/secrets.env 로 채우고 다시 실행하세요"
  info "사용 가능한 모델 확인: bash infra/select-model.sh"
  exit 2
fi
ok "모델 $BEDROCK_MODEL_ID"

# 어떤 키가 비었는지 미리 알려줍니다 (배포는 계속합니다 — 없어도 서비스는 돕니다)
for pair in "ALADIN_TTB_KEY:국내 도서 검색" "NLK_API_KEY:국내 서지(절판·구간)" \
            "HARDCOVER_TOKEN:무드·평점" "GOOGLE_BOOKS_API_KEY:커버리지"; do
  name="${pair%%:*}"; label="${pair##*:}"
  [ -n "${!name:-}" ] && ok "$name" || warn "$name 없음 — $label 사용 불가"
done

# ────────────────────────────────────────────────────────────
step "3/6  배포 (백엔드 + 프론트엔드 + 캐시 무효화)"
# ────────────────────────────────────────────────────────────
# update.sh 가 상태 복원 → 백엔드 → 프론트 → 무효화 → 진단을 순서대로 합니다.
SKIP_DOCTOR=0 ONLY="${ONLY:-all}" bash "$INFRA_DIR/update.sh" || die "배포 실패 — 위 메시지를 확인하세요"

# ────────────────────────────────────────────────────────────
step "4/6  가드레일 (WAF · 알람 · 예산)"
# ────────────────────────────────────────────────────────────
if [ "${SKIP_GUARDRAILS:-0}" = "1" ]; then
  skip "가드레일 (SKIP_GUARDRAILS=1)"
else
  # 재실행 안전합니다. 이미 있으면 건너뜁니다.
  bash "$INFRA_DIR/04-guardrails.sh" || warn "가드레일 일부 실패 (위 메시지 확인) — 배포 자체는 완료됐습니다"
fi

# ────────────────────────────────────────────────────────────
step "5/6  검증"
# ────────────────────────────────────────────────────────────
if [ "${SKIP_VERIFY:-0}" = "1" ]; then
  skip "검증 (SKIP_VERIFY=1)"
else
  # ★ FAST=1 로 부릅니다.
  #
  #   3/6 단계의 update.sh 가 마지막에 doctor.sh 를 돌리고, doctor 는 이미
  #   전파 대기 · 프론트 · 헬스 · 채팅 · 보안을 전부 확인합니다.
  #   verify.sh 를 그대로 또 돌리면 같은 검사를 두 번 하고 채팅을 두 번 더
  #   호출합니다. FAST 는 doctor 가 안 하는 것만 남깁니다
  #   (예시 질문 · 답변 평가 · 위조 거부 · 키 로드 상태).
  #
  #   전부 다시 확인하고 싶으면: FAST=0 bash infra/verify.sh
  FAST="${FAST:-1}" RATE_TEST="${RATE_TEST:-0}" bash "$INFRA_DIR/verify.sh" \
    || warn "검증에서 실패 항목을 보고했습니다 (위 내용 확인)"
fi

# ────────────────────────────────────────────────────────────
step "6/6  키 로드 확인"
# ────────────────────────────────────────────────────────────
state_load
DOMAIN="$(state_get DISTRIBUTION_DOMAIN)"
[ -n "$DOMAIN" ] || DOMAIN="$(bash "$INFRA_DIR/print-domain.sh" 2>/dev/null || true)"
SITE="https://$DOMAIN"

if [ -n "$DOMAIN" ]; then
  curl -s -m 30 "$SITE/api/health" | python3 - <<'PY' || warn "헬스체크 응답을 읽지 못했습니다"
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  ! 헬스체크 파싱 실패"); raise SystemExit
g='\033[32m'; y='\033[33m'; dm='\033[2m'; x='\033[0m'
se = d.get('secrets', {})
def m(v): return f"{g}있음{x}" if v else f"{y}없음{x}"
print(f"  ok={d.get('ok')}  "
      f"알라딘={m(se.get('ALADIN_TTB_KEY'))} "
      f"국중={m(se.get('NLK_API_KEY'))} "
      f"Hardcover={m(se.get('HARDCOVER_TOKEN'))} "
      f"Google={m(se.get('GOOGLE_BOOKS_API_KEY'))}")
for p in d.get('problems') or []:
    print(f"  {y}!{x} {p}")
for w in d.get('warnings') or []:
    print(f"  {dm}주의 {w}{x}")
PY
fi

# ────────────────────────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START ))
header "완료  (${ELAPSED}초)"
# ────────────────────────────────────────────────────────────

cat <<EOF
  ${C_BLD}$SITE${C_RST}

  ${C_DIM}캐시 전파에 1~3분 걸립니다. 바로 안 바뀌면 잠시 후 새로고침하세요.
  배포 직후 첫 몇 번은 느립니다 — 검색 캐시 키가 바뀌어 이전 캐시를 쓰지 않습니다.${C_RST}

${C_BLD}브라우저에서 확인할 것${C_RST}

  ${C_BLD}정책 — 이제 주제로 막지 않습니다${C_RST}
    "한국전쟁"                  → 한국전쟁 역사서·소설
    "제육볶음"                  → 한식 요리책·음식 에세이
    "제육볶음 레시피 알려줘"      → "레시피는 못 알려드리지만 요리책을…" 으로 전환
    "파이썬 크롤링 코드 짜줘"     → 파이썬 책 추천으로 전환
    ${C_DIM}거절만 하고 끝나면 실패입니다.${C_RST}

  ${C_BLD}검색 정확도${C_RST}
    "한국 스릴러 추천해줘"        → 정유정·김언수 같은 실제 스릴러
    ${C_DIM}한국사·여행서·연구서가 섞이면 실패입니다.${C_RST}
    "요즘 나온 한국 소설"         → 최근 출간작

  ${C_BLD}기존 기능${C_RST}
    책 카드의 [저장]             → 헤더에 '읽을 목록 (1)'
    답변 아래 [좋음/아쉬움]       → 누르면 감사 문구로 바뀜
    DynamoDB 쿼리 pk = LOG#$(TZ=Asia/Seoul date +%F)  → '평가' 속성

  ${C_DIM}다음 배포는 새 zip 업로드 후 같은 한 줄을 다시 붙여넣으면 됩니다.
  비밀값은 ~/keep/secrets.env 에 남아 있어 다시 입력할 필요가 없습니다.${C_RST}

EOF
