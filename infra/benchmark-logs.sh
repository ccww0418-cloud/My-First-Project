#!/usr/bin/env bash
#
# 벤치마크 실행 로그 — 우리 서비스가 무엇을 처리했는지
#
#   bash infra/benchmark-logs.sh              최근 1시간
#   bash infra/benchmark-logs.sh 30m          최근 30분
#   bash infra/benchmark-logs.sh 2h 41        최근 2시간 · 보낸 케이스 41건과 대조
#
# ══════════════════════════════════════════════════════════════
# 이 스크립트가 답하는 질문
# ══════════════════════════════════════════════════════════════
# GuardBench 가 41건을 보냈는데 11건이 검증되지 않았다면, 그 11건이
#
#   ① 우리에게 아예 닿지 못했나          → 스로틀(503). 로그에 아무것도 없음
#   ② 닿았지만 레이트리밋에 막혔나        → 429. '레이트리밋' 로그
#   ③ 처리했지만 너무 느렸나             → 15초 초과. totalMs 확인
#   ④ 처리 중 터졌나                    → '모델 호출 실패' / '빈 응답'
#
# 중 어느 것인지 가릅니다. ★ 핵심은 ①입니다 — 스로틀된 요청은 Lambda 가
# 시작조차 못 하므로 **로그가 남지 않습니다.** 그래서 "보낸 수 vs 로그에 있는 수"
# 의 차이가 곧 스로틀 건수입니다.
# ══════════════════════════════════════════════════════════════
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

SINCE="${1:-1h}"
EXPECTED="${2:-}"
LOG_GROUP="/aws/lambda/${FUNCTION_NAME}"

# 상대 시간 → epoch 밀리초 (GNU date / BSD date 둘 다)
to_ms() {
  local spec="$1" n unit
  n="${spec%[smhd]}"; unit="${spec##*[0-9]}"
  case "$unit" in
    s) n=$(( n )) ;;
    m) n=$(( n * 60 )) ;;
    h) n=$(( n * 3600 )) ;;
    d) n=$(( n * 86400 )) ;;
    *) n=3600 ;;
  esac
  echo $(( ( $(date +%s) - n ) * 1000 ))
}
START_MS="$(to_ms "$SINCE")"

step "대상  $LOG_GROUP   최근 $SINCE"

# ── 1. Lambda 스로틀 지표 ──────────────────────────────────────
step "1. Lambda 스로틀 — 요청이 시작조차 못 한 횟수"
THROTTLES="$(aws cloudwatch get-metric-statistics --region "$REGION" \
  --namespace AWS/Lambda --metric-name Throttles \
  --dimensions Name=FunctionName,Value="$FUNCTION_NAME" \
  --start-time "$(date -u -r $((START_MS/1000)) +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d "@$((START_MS/1000))" +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum \
  --query 'sum(Datapoints[].Sum)' --output text 2>/dev/null || echo "?")"
if [ "$THROTTLES" = "None" ] || [ -z "$THROTTLES" ]; then THROTTLES=0; fi
if [ "$THROTTLES" = "?" ]; then
  warn "지표 조회 실패 (cloudwatch:GetMetricStatistics 권한 확인)"
elif [ "${THROTTLES%.*}" -gt 0 ] 2>/dev/null; then
  fail "스로틀 ${THROTTLES%.*}회 — 예약 동시성 상한에 막혔습니다"
  info "해결: bash infra/benchmark-mode.sh on"
else
  ok "스로틀 0회"
fi

CONC="$(aws lambda get-function-concurrency --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --query 'ReservedConcurrentExecutions' --output text 2>/dev/null || echo "?")"
if [ "$CONC" = "None" ]; then ok "예약 동시성 없음 (벤치마크 모드)"; else warn "예약 동시성 $CONC — 동시 요청이 이보다 많으면 503"; fi

# ── 2. OpenAI 경로 로그 집계 ──────────────────────────────────
step "2. OpenAI 경로가 실제로 처리한 요청"
aws logs filter-log-events --region "$REGION" \
  --log-group-name "$LOG_GROUP" --start-time "$START_MS" \
  --filter-pattern 'openai 엔드포인트' \
  --query 'events[].message' --output json 2>/dev/null \
  > "$INFRA_DIR/.bm-logs.json" || { warn "로그 조회 실패 — 로그 그룹이 없거나 권한 부족"; rm -f "$INFRA_DIR/.bm-logs.json"; exit 0; }

EXPECTED="$EXPECTED" python3 - "$INFRA_DIR/.bm-logs.json" <<'PY'
import json, sys, os, re
raw = json.load(open(sys.argv[1], encoding='utf-8')) or []
recs = []
for line in raw:
    m = re.search(r'\{.*\}', line, re.S)
    if not m:
        continue
    try:
        recs.append(json.loads(m.group(0)))
    except Exception:
        pass

def kind(r):
    msg = r.get('msg') or r.get('message') or ''
    if '완료' in msg:        return 'done'
    if '정책 차단' in msg:    return 'blocked'
    if '레이트리밋' in msg:   return 'ratelimited'
    if '모델 호출 실패' in msg: return 'model_error'
    if '빈 응답' in msg:      return 'empty'
    return 'other'

from collections import Counter
c = Counter(kind(r) for r in recs)
total = sum(c.values())

label = {'done': '정상 응답', 'blocked': '정책 차단', 'ratelimited': '레이트리밋 429',
         'model_error': '모델 호출 실패', 'empty': '빈 응답', 'other': '기타'}
for k in ['done', 'blocked', 'ratelimited', 'model_error', 'empty', 'other']:
    if c.get(k):
        print(f"  {label[k]:<16} {c[k]:>4}건")
print(f"  {'─'*22}")
print(f"  {'로그에 있는 총':<16} {total:>4}건")

exp = os.environ.get('EXPECTED', '').strip()
if exp.isdigit():
    gap = int(exp) - total
    print()
    if gap > 0:
        print(f"  ⚠️  보낸 {exp}건 중 {gap}건이 로그에 없습니다.")
        print(f"      Lambda 가 시작조차 못 한 것 = 스로틀(503) 입니다.")
    elif gap < 0:
        print(f"  보낸 {exp}건보다 {-gap}건 많습니다 — GuardBench 재시도(최대 3회)로 보입니다.")
    else:
        print(f"  ✅ 보낸 {exp}건이 전부 로그에 있습니다. 스로틀 없음.")

# 15초 벽에 가까운 요청
slow = sorted((r.get('totalMs', 0) for r in recs if kind(r) == 'done'), reverse=True)
if slow:
    print()
    print(f"  응답 시간 (GuardBench 타임아웃 15,000ms)")
    print(f"    최대 {slow[0]:,}ms · 중간 {slow[len(slow)//2]:,}ms · 최소 {slow[-1]:,}ms")
    over = [s for s in slow if s > 15000]
    near = [s for s in slow if 12000 < s <= 15000]
    if over:
        print(f"    ✗ 15초 초과 {len(over)}건 — PROVIDER_TIMEOUT 으로 기록됩니다")
    if near:
        print(f"    ! 12~15초 {len(near)}건 — 느린 날 넘칠 수 있습니다")
    if not over and not near:
        print(f"    ✅ 전부 12초 미만")

# 차단 코드 분포
bl = Counter(r.get('code') for r in recs if kind(r) == 'blocked')
if bl:
    print()
    print("  차단 코드")
    for code, n in bl.most_common():
        print(f"    {code:<22} {n}건")
    lay = Counter(r.get('layer') for r in recs if kind(r) == 'blocked')
    print("  차단 단계  " + " · ".join(f"{k}={v}" for k, v in lay.most_common()))
PY
rm -f "$INFRA_DIR/.bm-logs.json"

# ── 3. GuardBench 쪽에서 볼 것 ────────────────────────────────
step "3. GuardBench 쪽 케이스별 판정"
cat <<'EOS'
  실패한 것만 보기
    GET /api/v1/test-runs/{testRunId}/results?executionStatus=FAILED&size=100

  단정 실패만 보기 (실행은 됐는데 판정에서 떨어진 것)
    GET /api/v1/test-runs/{testRunId}/results?assertionStatus=FAIL&size=100

  놓친 공격만 보기
    GET /api/v1/test-runs/{testRunId}/results?evaluationOutcome=FALSE_NEGATIVE&size=100

  정상을 막은 것만 보기 (대조군 오탐)
    GET /api/v1/test-runs/{testRunId}/results?evaluationOutcome=FALSE_POSITIVE&size=100

  응답 항목에서 볼 필드
    executionStatus     SUCCEEDED | FAILED | TIMED_OUT | NOT_STARTED
    error.stage / .code / .message
    assertionStatus     PASS | FAIL
    evaluationOutcome   TRUE_POSITIVE | TRUE_NEGATIVE | FALSE_POSITIVE | FALSE_NEGATIVE
    evaluatorVerdict    평가자 판정 원문

  error.code 로 원인 가리기
    PROVIDER_UNAVAILABLE          우리 5xx → 스로틀(503)일 가능성이 큽니다
    PROVIDER_TIMEOUT              15초 초과
    TARGET_CONFIGURATION_INVALID  우리 4xx → 429(레이트리밋) 또는 model 불일치
    TARGET_ACCESS_DENIED          401/403 → 함수 URL 을 직접 넣었을 때
    TARGET_NOT_FOUND              404 → URL 경로 오타
    PROVIDER_RESPONSE_INVALID     JSON 아님 / choices[0].message.content 비어 있음
EOS
