#!/usr/bin/env bash
#
# 배포 검증 — 실제로 동작하는지 순서대로 확인합니다.
#
#   bash infra/verify.sh
#
# CloudFront 전파를 기다렸다가(--wait 기본) 헬스체크 → 스트리밍 채팅 →
# 보안(직접 접근 차단) → 레이트리밋까지 점검합니다.
# ============================================================
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

require_cli
require_creds
state_load

DIST_ID="$(state_get DISTRIBUTION_ID)"
SITE="$(state_get SITE_URL)"
FURL="$(state_get FUNCTION_URL)"
BUCKET="$(state_get BUCKET_NAME)"

# ★ SITE_URL 은 seed-state.sh 가 기록하지 않는 키입니다.
#   지금까지는 update.sh 끝의 doctor.sh 가 .state 를 재작성하면서 채워줬습니다.
#   그래서 SKIP_DOCTOR=1 로 배포하거나 doctor 가 중간에 멈추면
#   여기서 "배포 정보가 없습니다" 로 죽고, 엉뚱하게 deploy-all.sh 를 안내했습니다.
#   도메인만 있으면 만들 수 있는 값이므로 직접 조립합니다.
if [ -z "$SITE" ]; then
  DOMAIN="$(state_get DISTRIBUTION_DOMAIN)"
  if [ -z "$DOMAIN" ] && [ -n "$DIST_ID" ]; then
    DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" \
      --query 'Distribution.DomainName' --output text 2>/dev/null || true)"
  fi
  if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "None" ]; then
    SITE="https://$DOMAIN"
    state_set SITE_URL "$SITE"
    info "SITE_URL 을 배포 도메인에서 복원했습니다"
  fi
fi

[ -n "$SITE" ] || die "배포 정보가 없습니다. bash infra/seed-state.sh 를 먼저 실행하세요."

header "배포 검증"
info "대상: $SITE"

# ★ FAST=1 — doctor.sh 가 이미 한 검사를 건너뜁니다.
#
#   update.sh 는 마지막에 QUICK=1 doctor.sh 를 돌립니다. doctor 는
#   CloudFront 전파 대기 · 프론트(index.html/번들/SPA) · 헬스체크 ·
#   실제 채팅 · 보안(S3 403, API 직접 403, HTTPS) 를 전부 이미 합니다.
#   그래서 verify.sh 를 그대로 또 돌리면 같은 검사를 두 번 하고,
#   특히 **채팅을 두 번 더 호출**합니다(Bedrock 비용 + 하루 할당량 소모).
#
#   FAST=1 은 doctor 가 안 하는 것만 남깁니다:
#     · /api/config (예시 질문)
#     · 답변 평가 저장 + 위조된 기록 위치 거부
FAST="${FAST:-0}"
[ "$FAST" = "1" ] && info "FAST 모드 — doctor.sh 와 겹치는 검사를 건너뜁니다"

# 레이트리밋 검사는 채팅을 한도+1회 호출합니다(기본 11회).
# Bedrock 비용이 들고 하루 할당량(150회)에서 11회를 깎고 1분 가까이 걸립니다.
# 배포마다 확인할 값이 아니므로 기본 끕니다. 필요할 때만 RATE_TEST=1.
RATE_TEST="${RATE_TEST:-0}"

PASS=0; FAIL=0
t_pass() { ok "$*"; PASS=$((PASS+1)); }
t_fail() { fail "$*"; FAIL=$((FAIL+1)); }

# ────────────────────────────────────────────────────────────
step "CloudFront 배포 상태"
# ────────────────────────────────────────────────────────────
if [ "$FAST" = "1" ]; then
  skip "전파 대기 (doctor.sh 가 이미 대기했습니다)"
  STATUS=Deployed
else
for i in $(seq 1 40); do
  STATUS="$(aws cloudfront get-distribution --id "$DIST_ID" \
    --query 'Distribution.Status' --output text 2>/dev/null || echo Unknown)"
  if [ "$STATUS" = "Deployed" ]; then
    t_pass "상태 Deployed"
    break
  fi
  printf '\r  %s배포 전파 대기 중... %s (%d/40, 30초 간격)%s' "$C_DIM" "$STATUS" "$i" "$C_RST"
  sleep 30
done
printf '\r%*s\r' 70 ''
[ "$STATUS" = "Deployed" ] || { t_fail "아직 전파 중 ($STATUS) — 몇 분 후 다시 실행하세요"; }
fi

# ────────────────────────────────────────────────────────────
step "프론트엔드"
# ────────────────────────────────────────────────────────────
if [ "$FAST" = "1" ]; then
  skip "프론트엔드 (doctor.sh 가 index.html·번들·SPA 를 확인했습니다)"
else
CODE="$(curl -s -o /tmp/bb-index.html -w '%{http_code}' -m 20 "$SITE/")"
if [ "$CODE" = "200" ] && grep -q '<div id="root">' /tmp/bb-index.html; then
  t_pass "index.html 200 (React 마운트 지점 확인)"
else
  t_fail "index.html HTTP $CODE"
fi

# SPA 라우팅 — 없는 경로도 index.html을 200으로 반환해야 함
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$SITE/does-not-exist")"
[ "$CODE" = "200" ] && t_pass "SPA 라우팅 (없는 경로 → index.html 200)" \
                    || t_fail "SPA 라우팅 실패 (HTTP $CODE) — 사용자 정의 오류 응답 확인"
fi

# ────────────────────────────────────────────────────────────
step "API 헬스체크"
# ────────────────────────────────────────────────────────────
# doctor.sh 도 헬스체크를 하지만, 여기서는 **키 로드 상태와 warnings** 를 보여줍니다.
# doctor 는 problems 만 봅니다. 그래서 FAST 에서도 남깁니다 (호출 1회, 비용 없음).
HEALTH="$(curl -s -m 30 "$SITE/api/health" || true)"
if printf '%s' "$HEALTH" | grep -q '"ok"'; then
  python3 - <<PY
import json
try:
    d = json.loads('''$HEALTH''')
except Exception:
    print("  ! 파싱 실패"); raise SystemExit
g='\033[32m'; r='\033[31m'; y='\033[33m'; dm='\033[2m'; x='\033[0m'
print(f"  {'✓' if d.get('ok') else '✗'} ok = {d.get('ok')}")
reg=d.get('regions',{})
print(f"  {dm}리전  lambda={reg.get('lambda')} ddb={reg.get('dynamodb')} ssm={reg.get('ssm')} bedrock={reg.get('bedrock')}{x}")
bd=d.get('bedrock',{})
print(f"  {dm}모델  {bd.get('modelId')} (형식유효={bd.get('modelIdLooksValid')}){x}")
dy=d.get('dynamodb',{})
print(f"  {dm}DDB   ok={dy.get('ok')} {dy.get('latencyMs','')}ms{x}")
se=d.get('secrets',{})
def mark(v):
    return f"{g}있음{x}" if v else f"{y}없음{x}"
print(f"  {dm}키    Google={x}{mark(se.get('GOOGLE_BOOKS_API_KEY'))} "
      f"{dm}Hardcover={x}{mark(se.get('HARDCOVER_TOKEN'))} "
      f"{dm}알라딘={x}{mark(se.get('ALADIN_TTB_KEY'))} "
      f"{dm}국중={x}{mark(se.get('NLK_API_KEY'))}")
for i,p in enumerate(d.get('problems') or [], 1):
    print(f"  {y}!{x} {i}. {p}")
# warnings 는 "서비스는 도는데 품질이 떨어지는 상태"입니다.
# ok=true 라서 problems 만 보면 놓칩니다 — 실제로 알라딘 키가 없어도
# "모든 검증 통과"가 나왔습니다.
for w in d.get('warnings') or []:
    print(f"  {y}주의{x} {w}")
PY
  printf '%s' "$HEALTH" | grep -q '"ok": *true' && t_pass "헬스체크 통과" || t_fail "헬스체크에 problems 있음"
else
  t_fail "헬스체크 실패: $(printf '%s' "$HEALTH" | head -c 200)"
fi

# ────────────────────────────────────────────────────────────
step "예시 질문 (/api/config)"
# ────────────────────────────────────────────────────────────
CFG="$(curl -s -m 20 "$SITE/api/config" || true)"
printf '%s' "$CFG" | grep -q 'suggestions' && t_pass "설정 조회 OK" || t_fail "설정 조회 실패"

# ────────────────────────────────────────────────────────────
step "채팅 + 답변 평가 (실제 Bedrock 호출)"
# ────────────────────────────────────────────────────────────
# doctor.sh 도 채팅을 1회 호출합니다. 여기서 또 호출하는 이유는
# **답변 평가(logRef)** 를 확인해야 하고, 그러려면 채팅 응답의 logRef 가 필요하기
# 때문입니다. doctor 는 평가를 검사하지 않습니다. 그래서 FAST 에서도 남깁니다.
info "질문: \"무료로 읽을 수 있는 고전 소설 추천해줘\""
SSE="/tmp/bb-sse.txt"
: > "$SSE"

# -N 으로 curl 버퍼링 해제. 백그라운드로 돌리며 도착 시각을 기록합니다.
START_MS="$(python3 -c 'import time;print(int(time.time()*1000))')"
curl -sN -m 120 -X POST "$SITE/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"무료로 읽을 수 있는 고전 소설 추천해줘"}' > "$SSE" 2>/dev/null &
CURL_PID=$!

FIRST_CHUNK_MS=""
for i in $(seq 1 120); do
  if [ -s "$SSE" ] && [ -z "$FIRST_CHUNK_MS" ]; then
    FIRST_CHUNK_MS="$(python3 -c 'import time;print(int(time.time()*1000))')"
  fi
  kill -0 $CURL_PID 2>/dev/null || break
  sleep 1
done
wait $CURL_PID 2>/dev/null || true
END_MS="$(python3 -c 'import time;print(int(time.time()*1000))')"

if [ -s "$SSE" ]; then
  # ★ 응답 형태가 두 가지입니다. grep 으로 'data:' 줄만 세면 안 됩니다.
  #
  #   API Gateway 모드에서는 핸들러가 src/index.bufferedHandler 라
  #   SSE 가 아니라 단일 JSON({sessionId, answer, books, events})이 옵니다.
  #   그런데 이 스크립트는 SSE 만 파싱해서, 정상 배포에서도
  #   "도구를 호출하지 않았습니다 / 책 데이터가 없습니다 / 답변 텍스트가 없습니다
  #    / done 이벤트 없음" 4건이 실패로 찍혔습니다. 실제 서비스는 멀쩡한데
  #   마지막 화면이 빨간색이라 배포가 실패한 것처럼 보였습니다.
  #
  #   두 형태를 같은 이벤트 목록으로 정규화해서 셉니다.
  python3 - "$SSE" "$INFRA_DIR/.chat-counts" <<'PY'
import json, sys

raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
events, mode = [], 'sse'

if raw.lstrip().startswith('{'):
    # 버퍼 JSON (API Gateway / BUFFERED)
    mode = 'buffered'
    try:
        body = json.loads(raw)
    except Exception:
        body = {}
    events = body.get('events') or []
    # events 가 없는 구버전 응답도 답변만 있으면 성공으로 봅니다
    if not events and body.get('answer'):
        events = [{'type': 'delta', 'text': body['answer']}, {'type': 'done'}]
        if body.get('books'):
            events.append({'type': 'books', 'items': body['books']})
else:
    for line in raw.splitlines():
        if not line.startswith('data:'):
            continue
        try:
            events.append(json.loads(line[5:].strip()))
        except Exception:
            pass

def n(t):
    return sum(1 for e in events if e.get('type') == t)

done = next((e for e in events if e.get('type') == 'done'), {})
text = ''.join(e.get('text', '') for e in events if e.get('type') == 'delta')
books = [b for e in events if e.get('type') == 'books' for b in (e.get('items') or [])]
if not books and done.get('bookCount'):
    books = [None] * int(done['bookCount'])

with open(sys.argv[2], 'w', encoding='utf-8') as f:
    f.write(f"MODE={mode}\n")
    f.write(f"N_EVENTS={len(events)}\n")
    f.write(f"N_DELTA={n('delta')}\n")
    f.write(f"HAS_BOOKS={1 if books else 0}\n")
    f.write(f"HAS_TOOL={n('tool_start')}\n")
    f.write(f"HAS_DONE={n('done')}\n")
    f.write(f"HAS_ERR={n('error')}\n")
    f.write(f"HAS_TEXT={1 if text.strip() else 0}\n")
    f.write(f"BOOK_COUNT={len(books)}\n")
    # 평가 기능 점검에 쓸 기록 위치. 없으면 빈 값.
    f.write(f"LOG_REF={done.get('logRef') or ''}\n")
    f.write(f"BLOCKED={1 if done.get('blocked') else 0}\n")
PY
  # shellcheck disable=SC1090
  . "$INFRA_DIR/.chat-counts"
  rm -f "$INFRA_DIR/.chat-counts"

  if [ "$MODE" = "buffered" ]; then
    info "버퍼 JSON 응답 (API Gateway 모드) — 이벤트 $N_EVENTS 개"
    info "스트리밍이 아닌 것은 정상입니다. bufferedHandler 가 한 번에 보냅니다."
  else
    info "SSE 이벤트 $N_EVENTS 개 (delta=$N_DELTA, books=$HAS_BOOKS, tool=$HAS_TOOL, done=$HAS_DONE)"
  fi
  [ -n "$FIRST_CHUNK_MS" ] && info "첫 바이트 $(( FIRST_CHUNK_MS - START_MS ))ms / 총 $(( END_MS - START_MS ))ms"

  if [ "$HAS_ERR" -gt 0 ]; then
    t_fail "오류 이벤트 발생:"
    grep '"type":"error"' "$SSE" | head -2 | sed 's/^/      /'
  fi
  [ "$HAS_TOOL" -gt 0 ]  && t_pass "도구 호출됨 (도서 API 연동 동작)"  || t_fail "도구를 호출하지 않았습니다"
  [ "$HAS_BOOKS" -gt 0 ] && t_pass "책 데이터 수신 ($BOOK_COUNT권)"    || t_fail "책 데이터가 없습니다"
  [ "$HAS_TEXT" -gt 0 ]  && t_pass "답변 텍스트 수신"                  || t_fail "답변 텍스트가 없습니다"
  [ "$HAS_DONE" -gt 0 ]  && t_pass "정상 종료"                          || t_fail "done 이벤트 없음"

  # 스트리밍 판정 — 버퍼 모드에서는 애초에 조각이 오지 않으므로 묻지 않습니다.
  if [ "$MODE" = "sse" ]; then
    if [ "$N_DELTA" -gt 5 ]; then
      t_pass "스트리밍 동작 (delta $N_DELTA 조각)"
    elif [ "$N_DELTA" -ge 1 ]; then
      warn "delta가 $N_DELTA 개뿐입니다 — 버퍼 모드로 동작 중일 수 있습니다"
      info "docs/02-aws-console-setup.md STEP 10의 '플랜 B'를 참고하세요"
    fi
  fi

  # ── 답변 평가 (신규 기능) ────────────────────────────────
  # 채팅이 돌려준 logRef 로 실제로 평가를 저장해봅니다.
  # 이게 없으면 평가 버튼이 눌리는지는 사람이 브라우저에서 눌러봐야만 알 수 있습니다.
  if [ -n "${LOG_REF:-}" ]; then
    FB_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "$SITE/api/feedback" \
      -H 'Content-Type: application/json' \
      -d "$(python3 -c 'import json,sys;print(json.dumps({"logRef":sys.argv[1],"verdict":"up"}))' "$LOG_REF")")"
    [ "$FB_CODE" = "200" ] && t_pass "답변 평가 저장 (POST /api/feedback)" \
                           || t_fail "평가 저장 실패 (HTTP $FB_CODE) — DynamoDB 쓰기 권한/기록 TTL 확인"

    # 위조한 위치로는 저장되지 않아야 합니다 (남의 세션 훼손 차단)
    BAD_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "$SITE/api/feedback" \
      -H 'Content-Type: application/json' \
      -d '{"logRef":"SESSION#00000000-0000-0000-0000-000000000000::META","verdict":"up"}')"
    [ "$BAD_CODE" = "400" ] && t_pass "위조된 기록 위치 거부 (400)" \
                            || t_fail "위조 요청이 400이 아닙니다 (HTTP $BAD_CODE) — logRef 검증 확인"
  elif [ "${BLOCKED:-0}" = "1" ]; then
    info "정책이 차단한 응답이라 평가 대상이 아닙니다 (의도된 동작)"
  else
    warn "logRef 가 없어 평가 기능을 확인할 수 없습니다"
    info "CHAT_LOG_ENABLED 가 0 이거나 DynamoDB 쓰기가 실패하면 평가 버튼이 안 나옵니다"
  fi

  # 답변 미리보기
  printf '\n%s  ── 답변 미리보기 ──%s\n' "$C_DIM" "$C_RST"
  python3 - "$SSE" <<'PY'
import json, sys

raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
text = ""
books = []

# 위 집계와 같은 이유로 두 형태를 모두 읽습니다.
# 이걸 안 하면 API Gateway 모드에서 미리보기가 항상 빈칸이었습니다.
if raw.lstrip().startswith('{'):
    try:
        body = json.loads(raw)
    except Exception:
        body = {}
    events = body.get('events') or []
    for e in events:
        if e.get('type') == 'delta': text += e.get('text', '')
        if e.get('type') == 'books': books += e.get('items') or []
    if not text:
        text = body.get('answer') or ''
    if not books:
        books = body.get('books') or []
else:
    for line in raw.splitlines():
        if not line.startswith('data:'): continue
        try: e = json.loads(line[5:].strip())
        except Exception: continue
        if e.get('type') == 'delta': text += e.get('text', '')
        if e.get('type') == 'books': books += e.get('items') or []

if books:
    print(f"  \033[2m추천 도서 {len(books)}권:\033[0m")
    for b in books[:4]:
        free = ' [무료]' if b.get('freeEbook') else ''
        rt = b.get('rating') or {}
        star = f" ★{rt.get('value')}" if rt.get('value') else ''
        src = '+'.join(b.get('sources', []))
        print(f"    - {b.get('title','?')[:45]} / {(b.get('authors') or ['?'])[0][:20]}{star}{free} \033[2m({src})\033[0m")
if text:
    body = text.strip().replace('\n', '\n    ')
    print(f"\n    {body[:500]}{'…' if len(body) > 500 else ''}")
PY
  printf '\n'
else
  t_fail "응답이 비어 있습니다 (타임아웃 또는 연결 실패)"
fi

# ────────────────────────────────────────────────────────────
step "보안 — 직접 접근이 차단되는지"
# ────────────────────────────────────────────────────────────
if [ "$FAST" = "1" ]; then
  skip "보안 (doctor.sh 가 S3 403 · API 직접 403 · HTTPS 를 확인했습니다)"
else
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
  "https://${BUCKET}.s3.${REGION}.amazonaws.com/index.html")"
[ "$CODE" = "403" ] && t_pass "S3 직접 접근 차단 (403)" \
                    || t_fail "S3가 직접 접근을 허용합니다 (HTTP $CODE) — 버킷 정책 확인"

if [ -n "$FURL" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$FURL")"
  [ "$CODE" = "403" ] && t_pass "Lambda URL 직접 접근 차단 (403)" \
                      || t_fail "Lambda URL이 직접 접근을 허용합니다 (HTTP $CODE) — 인증 유형 확인"
fi

# HTTP → HTTPS 리다이렉트
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "http://$(printf '%s' "$SITE" | sed 's#https://##')/")"
[ "$CODE" = "301" ] || [ "$CODE" = "302" ] && t_pass "HTTP → HTTPS 리다이렉트 ($CODE)" \
                                           || warn "HTTP 리다이렉트 응답 $CODE"
fi

# ────────────────────────────────────────────────────────────
step "레이트리밋"
# ────────────────────────────────────────────────────────────
if [ "$RATE_TEST" != "1" ]; then
  skip "레이트리밋 (채팅 $((RATE_LIMIT_PER_MINUTE + 1))회 호출 — RATE_TEST=1 로 켜세요)"
  info "Bedrock 비용이 들고 하루 할당량 $RATE_LIMIT_PER_DAY 회에서 $((RATE_LIMIT_PER_MINUTE + 1))회를 씁니다"
else
info "짧은 메시지를 $((RATE_LIMIT_PER_MINUTE + 1))회 연속 호출합니다..."
BLOCKED=0
for i in $(seq 1 $((RATE_LIMIT_PER_MINUTE + 1))); do
  R="$(curl -s -m 40 -X POST "$SITE/api/chat" \
    -H 'Content-Type: application/json' -d '{"message":"안녕"}' 2>/dev/null | head -c 400)"
  if printf '%s' "$R" | grep -q 'rate_limited'; then
    BLOCKED=$i; break
  fi
  printf '\r  %s%d/%d 호출...%s' "$C_DIM" "$i" "$((RATE_LIMIT_PER_MINUTE + 1))" "$C_RST"
done
printf '\r%*s\r' 50 ''
if [ "$BLOCKED" -gt 0 ]; then
  t_pass "레이트리밋 동작 (${BLOCKED}번째 요청에서 차단)"
else
  warn "레이트리밋에 걸리지 않았습니다 (분당 한도 $RATE_LIMIT_PER_MINUTE)"
  info "WAF나 CloudFront 캐시가 개입했을 수 있습니다. 로그를 확인하세요."
fi
fi

# ────────────────────────────────────────────────────────────
header "검증 결과"
# ────────────────────────────────────────────────────────────
printf '  %s%d 통과%s / %s%d 실패%s\n\n' "$C_GRN" "$PASS" "$C_RST" \
  "$([ $FAIL -gt 0 ] && printf '%s' "$C_RED" || printf '%s' "$C_DIM")" "$FAIL" "$C_RST"

if [ $FAIL -eq 0 ]; then
  printf '  %s브라우저에서 열어보세요:%s\n    %s\n\n' "$C_BLD" "$C_RST" "$SITE"
  printf '  %sopen %s%s\n\n' "$C_DIM" "$SITE" "$C_RST"
else
  printf '  실패 항목은 docs/05-runbook.md 의 "증상별 트러블슈팅"을 참고하세요.\n'
  printf '  로그: %saws logs tail /aws/lambda/%s --region %s --follow --format short%s\n\n' \
    "$C_DIM" "$FUNCTION_NAME" "$REGION" "$C_RST"
fi

rm -f /tmp/bb-index.html /tmp/bb-sse.txt
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
