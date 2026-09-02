#!/usr/bin/env bash
#
# Bedrock 모델 자동 선택
#
#   bash infra/select-model.sh              # 비용 우선 (haiku 먼저)
#   PREFER=sonnet bash infra/select-model.sh # 품질 우선
#   PREFER=list   bash infra/select-model.sh # 목록만 보고 직접 고르기
#
# 하는 일:
#   1) 이 리전에서 쓸 수 있는 Anthropic 추론 프로필을 전부 수집
#   2) 선호 순위로 정렬 (haiku/sonnet, 최신 날짜, us./global. 접두사)
#   3) 후보를 하나씩 실제 호출해서 "액세스 승인된 것"을 찾음 (maxTokens=5, 비용 거의 0)
#   4) 성공한 첫 모델을 infra/secrets.env 의 BEDROCK_MODEL_ID 에 기록
#
# 이렇게 하는 이유: 모델 라인업과 ID는 계속 바뀝니다. 문서에 적힌 ID를 믿지 말고
# 매번 계정에서 실제로 호출되는 것을 찾는 게 확실합니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

require_cli
require_creds
load_secrets

PREFER="${PREFER:-haiku}"

header "Bedrock 모델 선택  (리전 $BEDROCK_REGION)"

# ────────────────────────────────────────────────────────────
step "후보 수집"
# ────────────────────────────────────────────────────────────
PROFILES="$(aws bedrock list-inference-profiles \
  --region "$BEDROCK_REGION" --type-equals SYSTEM_DEFINED \
  --query "inferenceProfileSummaries[].inferenceProfileId" \
  --output text 2>/dev/null | tr '\t' '\n' | grep -i anthropic || true)"

# 추론 프로필이 없는 리전/모델을 위해 온디맨드 기본 모델도 후보에 포함
BASE_MODELS="$(aws bedrock list-foundation-models \
  --region "$BEDROCK_REGION" --by-provider anthropic --by-output-modality TEXT \
  --query "modelSummaries[?contains(inferenceTypesSupported,'ON_DEMAND') && responseStreamingSupported==\`true\`].modelId" \
  --output text 2>/dev/null | tr '\t' '\n' || true)"

ALL="$(printf '%s\n%s\n' "$PROFILES" "$BASE_MODELS" | sed '/^$/d' | sort -u)"

if [ -z "$ALL" ]; then
  fail "사용 가능한 Anthropic 모델을 찾지 못했습니다"
  cat <<EOF

  확인할 것:
  1) Bedrock 모델 액세스가 승인되었는지
     https://console.aws.amazon.com/bedrock/home?region=$BEDROCK_REGION#/modelaccess
  2) 리전이 맞는지 (현재 $BEDROCK_REGION)
  3) IAM 권한에 bedrock:ListInferenceProfiles / ListFoundationModels 가 있는지

EOF
  exit 1
fi

COUNT="$(printf '%s\n' "$ALL" | wc -l | tr -d ' ')"
ok "후보 $COUNT 개 발견"

# ────────────────────────────────────────────────────────────
step "선호 순위 정렬"
# ────────────────────────────────────────────────────────────
# 점수 규칙:
#   등급     선호가 haiku면 haiku>sonnet, sonnet이면 반대. opus는 비싸서 후순위
#   접두사   us.(리전내 처리) > global.(저렴/고처리량) > 접두사없음(쿼터 낮음)
#   날짜     최신 우선
#   버전     -vN:N 접미사가 있는 것만 (없으면 호출 실패)
RANKED="$(printf '%s\n' "$ALL" | python3 - "$PREFER" <<'PY'
import re, sys

prefer = sys.argv[1].lower()
rows = [l.strip() for l in sys.stdin if l.strip()]

# Bedrock 모델 ID 형식은 두 세대가 공존합니다:
#   레거시 (Claude Opus 4.6 이전)
#     [prefix.]anthropic.claude-sonnet-4-5-20250929-v1:0   날짜 + 버전 접미사
#   신형 (Claude Sonnet 4.6 이후) — Anthropic이 접미사를 없앴습니다
#     [prefix.]anthropic.claude-sonnet-4-6
# "접미사 없으면 무효"로 판정하면 최신 모델을 탈락시키므로 양쪽을 모두 인정합니다.

PREFIX_RE = re.compile(r'^(us|eu|apac|au|jp|global)\.')
DATE_RE   = re.compile(r'-(\d{8})(?:-|$)')
VER_RE    = re.compile(r'-v\d+:\d+$')
# claude-sonnet-4-6 / claude-3-5-sonnet / claude-sonnet-4-5-2025... 에서 세대 추출
GEN_RE    = re.compile(r'-(\d+)-(\d+)')


def parse(mid):
    low = mid.lower()
    pm = PREFIX_RE.match(low)
    prefix = pm.group(1) if pm else ''
    bare = low[len(prefix) + 1:] if prefix else low
    date = DATE_RE.search(bare)
    has_ver = bool(VER_RE.search(bare))
    # 세대: 날짜 부분을 떼고 나서 첫 x-y 쌍을 본다
    stripped = DATE_RE.sub('', bare)
    gm = GEN_RE.search(stripped)
    gen = (int(gm.group(1)), int(gm.group(2))) if gm else (0, 0)
    return prefix, bare, (date.group(1) if date else None), has_ver, gen


def score(mid):
    prefix, bare, date, has_ver, gen = parse(mid)
    s = 0.0

    # 1) 등급 — 선호에 따라 haiku/sonnet 우선. opus는 비싸서 후순위.
    if 'haiku' in bare:    tier = 3 if prefer == 'haiku' else 2
    elif 'sonnet' in bare: tier = 3 if prefer == 'sonnet' else 2
    elif 'opus' in bare:   tier = 0
    else:                  tier = 1
    s += tier * 10000

    # 2) ID 형식 정합성 — 확실히 깨진 조합만 강하게 감점
    if date and not has_ver:
        s -= 50000          # 레거시 ID에서 -v1:0 을 잘라먹은 잘못된 값
    else:
        s += 2000           # 정상 (신형 무접미사 또는 레거시 날짜+버전)

    # 3) 세대 — 4.6 > 4.5 > 3.7 ... (신형/레거시 공통 비교 가능)
    s += (gen[0] * 100 + gen[1] * 10) * 5

    # 4) 추론 범위
    #    us./eu./jp. 등 Geo  : 지역 내 처리 + 쿼터 넉넉
    #    global.             : 전 세계 라우팅, 처리량 최고, 약 10% 저렴
    #    접두사 없음(In-Region): 쿼터가 가장 낮아 데모 중 스로틀링 위험
    if   prefix == 'us':     s += 300
    elif prefix == 'global': s += 280
    elif prefix:             s += 200
    else:                    s += 50

    # 5) 같은 세대 안에서는 최신 날짜 우선 (레거시만 해당)
    if date:
        s += int(date) / 1e7

    return s


for mid in sorted(rows, key=score, reverse=True):
    print(mid)
PY
)"

printf '%s\n' "$RANKED" | head -8 | nl -w4 -s'. ' | sed 's/^/    /'
TOTAL="$(printf '%s\n' "$RANKED" | wc -l | tr -d ' ')"
[ "$TOTAL" -gt 8 ] && info "... 외 $((TOTAL - 8))개"

if [ "$PREFER" = "list" ]; then
  cat <<EOF

  위 목록에서 하나를 골라 infra/secrets.env 에 넣으세요:
    BEDROCK_MODEL_ID=<선택한 ID>

  가격 참고 (2026-08 기준, 100만 토큰당 입력/출력):
    haiku  계열   \$1 / \$5     ← 이 프로젝트에 충분합니다
    sonnet 계열   \$3 / \$15
    opus   계열   \$5+ / \$25+  ← 과합니다

EOF
  exit 0
fi

# ────────────────────────────────────────────────────────────
step "실제 호출 테스트 (액세스 승인 확인)"
# ────────────────────────────────────────────────────────────
info "maxTokens=5 로 최소 호출합니다. 후보당 비용은 0.001센트 미만입니다."

CHOSEN=""
TESTED=0
MAX_TESTS="${MAX_TESTS:-8}"

while IFS= read -r MODEL; do
  [ -n "$MODEL" ] || continue
  [ "$TESTED" -ge "$MAX_TESTS" ] && break
  TESTED=$((TESTED + 1))

  printf '  %s[%d] %s%s ... ' "$C_DIM" "$TESTED" "$MODEL" "$C_RST"

  if aws bedrock-runtime converse \
      --region "$BEDROCK_REGION" \
      --model-id "$MODEL" \
      --messages '[{"role":"user","content":[{"text":"hi"}]}]' \
      --inference-config '{"maxTokens":5}' \
      >/dev/null 2>"$INFRA_DIR/.model-err"; then
    printf '%s성공%s\n' "$C_GRN" "$C_RST"
    CHOSEN="$MODEL"
    break
  else
    ERR="$(head -c 400 "$INFRA_DIR/.model-err" | tr '\n' ' ')"
    case "$ERR" in
      *AccessDenied*)          printf '%s액세스 미승인%s\n' "$C_YEL" "$C_RST" ;;
      *ValidationException*)   printf '%s이 리전에서 무효%s\n' "$C_YEL" "$C_RST" ;;
      *ResourceNotFound*)      printf '%s모델 없음%s\n' "$C_YEL" "$C_RST" ;;
      *Throttling*)            printf '%s스로틀링 (액세스는 있음)%s\n' "$C_YEL" "$C_RST"
                               CHOSEN="$MODEL"; break ;;
      *)                       printf '%s실패%s\n' "$C_YEL" "$C_RST"
                               printf '        %s%s%s\n' "$C_DIM" "$(printf '%s' "$ERR" | head -c 150)" "$C_RST" ;;
    esac
  fi
done <<< "$RANKED"

rm -f "$INFRA_DIR/.model-err"

if [ -z "$CHOSEN" ]; then
  fail "호출 가능한 모델이 없습니다 (후보 $TESTED 개 시도)"
  cat <<EOF

  ${C_BLD}Bedrock 모델 액세스 승인이 필요합니다.${C_RST}
  이것만은 콘솔에서 해야 합니다 (Anthropic 모델은 사용 사례 양식 제출이 필수이고,
  이 양식에는 공개 API가 없습니다).

  1) https://console.aws.amazon.com/bedrock/home?region=$BEDROCK_REGION#/modelaccess
  2) "모델 액세스 수정" (Modify model access)
  3) Anthropic 항목에서 ${C_BLD}Claude Haiku${C_RST} 와 ${C_BLD}Claude Sonnet${C_RST} 체크
  4) 사용 사례 양식 (그대로 붙여넣어도 됩니다):

     회사 이름   : Personal Project
     웹사이트    : (GitHub 프로필 또는 블로그 URL)
     업종        : Education
     사용 사례   :
       Educational project. A book recommendation chatbot that uses public book
       APIs (Google Books, Open Library, Project Gutenberg, Hardcover) and Claude
       to explain why each book fits the user's request. Internal demo, expected
       under 2,000 requests total over 2 weeks.

  5) 제출 → 상태가 "액세스 부여됨"이 되면 (보통 즉시~수 분) 이 스크립트를 다시 실행

     bash infra/select-model.sh

EOF
  exit 1
fi

# ────────────────────────────────────────────────────────────
step "secrets.env 기록"
# ────────────────────────────────────────────────────────────
if [ ! -f "$SECRETS_FILE" ]; then
  cp "$INFRA_DIR/secrets.env.example" "$SECRETS_FILE" 2>/dev/null || touch "$SECRETS_FILE"
fi

# BEDROCK_MODEL_ID 행을 교체 (없으면 추가). macOS sed 호환을 위해 python 사용
python3 - "$SECRETS_FILE" "$CHOSEN" <<'PY'
import sys, re
path, model = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    lines = f.read().splitlines()
found = False
out = []
for ln in lines:
    if re.match(r'^\s*BEDROCK_MODEL_ID\s*=', ln):
        out.append(f'BEDROCK_MODEL_ID={model}')
        found = True
    else:
        out.append(ln)
if not found:
    out.append(f'BEDROCK_MODEL_ID={model}')
with open(path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(out) + '\n')
PY

ok "BEDROCK_MODEL_ID=$CHOSEN"

# 등급별 예상 비용 안내
case "$CHOSEN" in
  *haiku*)  info "가격대: 약 \$1/\$5 per 1M 토큰 → 2주 소규모 데모 약 \$17" ;;
  *sonnet*) info "가격대: 약 \$3/\$15 per 1M 토큰 → 2주 소규모 데모 약 \$51" ;;
  *opus*)   warn "opus는 비쌉니다. PREFER=haiku 로 다시 실행하는 것을 권합니다" ;;
esac

printf '\n'
ok "모델 선택 완료"
printf '  다음: %sbash infra/deploy-all.sh%s\n\n' "$C_BLD" "$C_RST"
