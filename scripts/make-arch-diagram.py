#!/usr/bin/env python3
"""BookBot AWS 인프라 아키텍처 다이어그램 — AWS 공식 다이어그램 형식

실행:  /tmp/pptenv/bin/python scripts/make-arch-diagram.py
결과:  docs/aws-architecture.png   (1600x1120, 2배 슈퍼샘플링 후 축소)

AWS 공식 아이콘 에셋이 없어 카테고리 색 + 단순 글리프로 재현했습니다.
색은 AWS 아이콘 세트의 카테고리 색을 따릅니다.
모든 수치는 config.mjs · policy.mjs · /api/health 와 대조한 값입니다.
"""

from PIL import Image, ImageDraw, ImageFont
import math, os

S = 2
W, H = 1600, 1120
OUT = "docs/aws-architecture.png"
TTC = "/System/Library/Fonts/AppleSDGothicNeo.ttc"

# ── AWS 카테고리 색 ───────────────────────────────────────────────
NET  = (140,  79, 255)   # Networking & Content Delivery
COMP = (237, 113,   0)   # Compute
STOR = (122, 161,  22)   # Storage
DB   = (201,  37, 209)   # Database
AI   = (  1, 168, 141)   # AI / ML
MGMT = (231,  21, 123)   # Management · App Integration · Cloud Financial
SEC  = (221,  52,  76)   # Security, Identity & Compliance

INK   = ( 22,  25,  28)
GREY  = (116, 122, 128)
LGREY = (201, 206, 211)
FAINT = (232, 235, 238)
DASH  = (152, 158, 164)
BLUE  = ( 31,  92, 139)
RED   = (183,  42,  38)
WHITE = (255, 255, 255)
NAVY  = ( 35,  47,  62)
CLOUDBG = (250, 250, 251)
EXTBG   = (245, 250, 244)
EXTLN   = ( 74, 124,  74)
PILLBG  = (247, 248, 249)

_fc = {}
def F(size, w="R"):
    idx = {"R": 0, "M": 2, "SB": 4, "B": 6}[w]
    k = (round(size, 1), idx)
    if k not in _fc:
        _fc[k] = ImageFont.truetype(TTC, int(size * S), index=idx)
    return _fc[k]

img = Image.new("RGB", (W * S, H * S), WHITE)
d = ImageDraw.Draw(img)

def sc(v): return int(round(v * S))
def bx(x, y, w, h): return [sc(x), sc(y), sc(x + w), sc(y + h)]
def lw(v): return max(1, sc(v))


# ── 기본 도형 (전부 논리 좌표를 받아 내부에서 배율 적용) ─────────────
def rrect(x, y, w, h, r=8, fill=None, outline=None, width=1):
    d.rounded_rectangle(bx(x, y, w, h), radius=sc(r), fill=fill, outline=outline, width=lw(width))

def rect(x, y, w, h, fill=None, outline=None, width=1):
    d.rectangle(bx(x, y, w, h), fill=fill, outline=outline, width=lw(width))

def line(x0, y0, x1, y1, color=INK, width=1.5):
    d.line([sc(x0), sc(y0), sc(x1), sc(y1)], fill=color, width=lw(width))

def poly(pts, fill=None, outline=None, width=1.5):
    p = [(sc(a), sc(b)) for a, b in pts]
    if fill: d.polygon(p, fill=fill)
    if outline:
        for i in range(len(p)):
            d.line([p[i], p[(i + 1) % len(p)]], fill=outline, width=lw(width))

def ell(x0, y0, x1, y1, fill=None, outline=None, width=1.5):
    d.ellipse([sc(x0), sc(y0), sc(x1), sc(y1)], fill=fill, outline=outline, width=lw(width))

def arc(x0, y0, x1, y1, a, b, color=INK, width=1.5):
    d.arc([sc(x0), sc(y0), sc(x1), sc(y1)], start=a, end=b, fill=color, width=lw(width))

def dashed(x0, y0, x1, y1, color=DASH, width=1.2, dash=7, gap=5):
    L = math.hypot(x1 - x0, y1 - y0)
    if L == 0: return
    ux, uy = (x1 - x0) / L, (y1 - y0) / L
    t = 0.0
    while t < L:
        e = min(t + dash, L)
        line(x0 + ux * t, y0 + uy * t, x0 + ux * e, y0 + uy * e, color, width)
        t = e + gap

def dbox(x, y, w, h, color=DASH, width=1.3):
    dashed(x, y, x + w, y, color, width); dashed(x + w, y, x + w, y + h, color, width)
    dashed(x + w, y + h, x, y + h, color, width); dashed(x, y + h, x, y, color, width)

def head(x, y, ang, color, sz=7):
    a1, a2 = ang + 2.65, ang - 2.65
    poly([(x, y), (x + sz * math.cos(a1), y + sz * math.sin(a1)),
          (x + sz * math.cos(a2), y + sz * math.sin(a2))], fill=color)

def arrow(x0, y0, x1, y1, color=INK, width=1.6, sz=7, dash=False):
    ang = math.atan2(y1 - y0, x1 - x0)
    ex, ey = x1 - sz * .74 * math.cos(ang), y1 - sz * .74 * math.sin(ang)
    (dashed if dash else line)(x0, y0, ex, ey, color, width)
    head(x1, y1, ang, color, sz)

def text(s, x, y, size=13, w="R", color=INK, anchor="la", spacing=1.38):
    for i, ln in enumerate(s.split("\n")):
        d.text((sc(x), sc(y + i * size * spacing)), ln, font=F(size, w), fill=color, anchor=anchor)

def tw(s, size=13, w="R"):
    return d.textlength(s, font=F(size, w)) / S


# ── AWS 아이콘 ────────────────────────────────────────────────────
def icon(x, y, sz, color, glyph):
    rrect(x, y, sz, sz, r=sz * .17, fill=color)
    glyph(x + sz / 2, y + sz / 2, sz * .30)

def gl_cloudfront(cx, cy, k):
    ell(cx - k, cy - k, cx + k, cy + k, outline=WHITE, width=1.8)
    ell(cx - k * .42, cy - k, cx + k * .42, cy + k, outline=WHITE, width=1.4)
    line(cx - k, cy, cx + k, cy, WHITE, 1.4)

def gl_waf(cx, cy, k):
    poly([(cx, cy - k * 1.05), (cx + k * .92, cy - k * .60), (cx + k * .92, cy + k * .20),
          (cx, cy + k * 1.05), (cx - k * .92, cy + k * .20), (cx - k * .92, cy - k * .60)],
         outline=WHITE, width=1.8)
    line(cx - k * .42, cy + k * .02, cx - k * .06, cy + k * .40, WHITE, 2.1)
    line(cx - k * .06, cy + k * .40, cx + k * .48, cy - k * .42, WHITE, 2.1)

def gl_s3(cx, cy, k):
    poly([(cx - k * .90, cy - k * .88), (cx + k * .90, cy - k * .88),
          (cx + k * .60, cy + k * 1.0), (cx - k * .60, cy + k * 1.0)], outline=WHITE, width=1.8)
    line(cx - k * .78, cy - k * .34, cx + k * .78, cy - k * .34, WHITE, 1.3)

def gl_apigw(cx, cy, k):
    for a in (0, 90, 180, 270):
        r = math.radians(a)
        arrow(cx + k * .26 * math.cos(r), cy + k * .26 * math.sin(r),
              cx + k * 1.0 * math.cos(r), cy + k * 1.0 * math.sin(r), WHITE, 1.7, sz=k * .42)

def gl_lambda(cx, cy, k):
    line(cx - k * .88, cy - k * .86, cx - k * .34, cy - k * .86, WHITE, 2.2)
    line(cx - k * .40, cy - k * .82, cx + k * .80, cy + k * .90, WHITE, 2.2)
    line(cx - k * .88, cy + k * .90, cx + k * .10, cy - k * .28, WHITE, 2.2)

def gl_bedrock(cx, cy, k):
    pts = [(cx, cy - k * .95), (cx - k * .90, cy - k * .16), (cx - k * .56, cy + k * .88),
           (cx + k * .56, cy + k * .88), (cx + k * .90, cy - k * .16)]
    poly(pts, outline=WHITE, width=1.5)
    for x, y in pts:
        line(cx, cy, x, y, WHITE, 1.0)
        ell(x - k * .17, y - k * .17, x + k * .17, y + k * .17, fill=WHITE)
    ell(cx - k * .21, cy - k * .21, cx + k * .21, cy + k * .21, fill=WHITE)

def gl_dynamodb(cx, cy, k):
    for oy in (-.60, 0, .60):
        ell(cx - k * .92, cy + k * oy - k * .25, cx + k * .92, cy + k * oy + k * .25,
            outline=WHITE, width=1.7)
    for sx in (-.92, .92):
        line(cx + k * sx, cy - k * .60, cx + k * sx, cy + k * .60, WHITE, 1.7)

def gl_ssm(cx, cy, k):
    poly([(cx - k * .70, cy - k * .95), (cx + k * .38, cy - k * .95), (cx + k * .70, cy - k * .58),
          (cx + k * .70, cy + k * .95), (cx - k * .70, cy + k * .95)], outline=WHITE, width=1.7)
    for oy in (-.38, -.06, .26):
        line(cx - k * .44, cy + k * oy, cx + k * .44, cy + k * oy, WHITE, 1.3)
    ell(cx + k * .22, cy + k * .42, cx + k * .82, cy + k * 1.02, fill=WHITE)

def gl_cloudwatch(cx, cy, k):
    arc(cx - k * .92, cy - k * .74, cx + k * .92, cy + k * 1.10, 180, 360, WHITE, 1.9)
    line(cx, cy + k * .16, cx + k * .54, cy - k * .38, WHITE, 1.9)
    ell(cx - k * .14, cy + k * .04, cx + k * .14, cy + k * .32, fill=WHITE)

def gl_sns(cx, cy, k):
    ell(cx - k * .28, cy - k * .28, cx + k * .28, cy + k * .28, fill=WHITE)
    for a in (208, 246, 284, 322):
        r = math.radians(a)
        line(cx + k * .46 * math.cos(r), cy + k * .46 * math.sin(r),
             cx + k * .98 * math.cos(r), cy + k * .98 * math.sin(r), WHITE, 1.7)

def gl_budgets(cx, cy, k):
    for ox, hh in ((-.58, .34), (-.02, .68), (.54, 1.00)):
        rect(cx + k * ox - k * .19, cy + k * .80 - k * hh, k * .38, k * hh, fill=WHITE)
    dashed(cx - k * .95, cy - k * .52, cx + k * .95, cy - k * .52, WHITE, 1.5, 4, 3)

def gl_lock(cx, cy, k):
    arc(cx - k * .50, cy - k * .96, cx + k * .50, cy + k * .04, 180, 360, WHITE, 1.9)
    rrect(cx - k * .76, cy - k * .20, k * 1.52, k * 1.04, r=k * .18, fill=WHITE)
    ell(cx - k * .13, cy + k * .18, cx + k * .13, cy + k * .44, fill=(0, 0, 0))

def gl_check(cx, cy, k):
    ell(cx - k, cy - k, cx + k, cy + k, outline=WHITE, width=1.8)
    line(cx - k * .44, cy + k * .04, cx - k * .08, cy + k * .42, WHITE, 2.1)
    line(cx - k * .08, cy + k * .42, cx + k * .50, cy - k * .40, WHITE, 2.1)


def svc(cx, top, color, glyph, title, subs=(), isz=54, tsz=14.5, ssz=11.5):
    """아이콘 + 아래 가운데 정렬 라벨. 라벨 블록 하단 y 를 반환"""
    icon(cx - isz / 2, top, isz, color, glyph)
    y = top + isz + 8
    text(title, cx, y, tsz, "B", INK, anchor="ma"); y += tsz * 1.40
    for s in subs:
        text(s, cx, y, ssz, "R", GREY, anchor="ma"); y += ssz * 1.44
    return y

def svc_row(x, cy, color, glyph, title, sub=None, isz=40, tsz=13, ssz=10.5):
    icon(x, cy - isz / 2, isz, color, glyph)
    tx = x + isz + 11
    if sub:
        text(title, tx, cy - isz / 2, tsz, "B", INK)
        text(sub, tx, cy - isz / 2 + tsz * 1.44, ssz, "R", GREY)
    else:
        text(title, tx, cy, tsz, "B", INK, anchor="lm")

def badge(x, y, n, r=11):
    ell(x - r, y - r, x + r, y + r, fill=BLUE)
    text(str(n), x, y + .5, 11.5, "B", WHITE, anchor="mm")


# ══════════════════════════════════════════════════════════════════
# 레이아웃 좌표 — 한자리에 모아 둡니다 (겹침을 여기서 관리)
# ══════════════════════════════════════════════════════════════════
CX, CY, CW, CH = 150, 116, 968, 572        # AWS Cloud 경계
ISZ = 54                                    # 주요 아이콘 크기
CF, CFT = 246, 296                          # CloudFront
BUS = 340                                   # 경로 분기 버스 x
S3Y, AGY = 262, 424                         # 위(정적) / 아래(API) 갈래 y
COL2 = 502                                  # S3 · API Gateway 열
LM = 752                                    # Lambda 열
OX, OY, OW, OH = 172, 548, 518, 124         # 관측 · 비용 방어 상자
MX, MY, MW, MH = 1160, 116, 408, 260        # 관리형 서비스 상자
MBUS = 1132                                 # 관리형 서비스로 가는 버스 x
LX, LY, LW, LH = 1160, 396, 408, 458        # 흐름 범례
EX, EY, EW, EH = 150, 706, 968, 148         # 외부 인터넷 상자
PX, PY, PW, PH = 36, 882, W - 72, 144       # 바닥 5개 축

# ══════════════════════════════════════════════════════════════════
# 머리말
# ══════════════════════════════════════════════════════════════════
text("BookBot AWS 인프라 아키텍처", 36, 26, 34, "B", INK)
text("리전:", 36, 80, 16.5, "B", INK)
text("us-east-1 (버지니아 북부)", 36 + tw("리전: ", 16.5, "B") + 5, 80, 16.5, "B", BLUE)

for i, b in enumerate(["정적 호스팅 · 서버리스 API · 외부 도서 API 6곳으로 존재 검증",
                       "단일 계정 · VPC 없음 — 전부 관리형 서비스"]):
    ell(966, 33 + i * 27, 971, 38 + i * 27, fill=INK)
    text(b, 982, 27 + i * 27, 14.5, "M", INK)

# ══════════════════════════════════════════════════════════════════
# AWS Cloud 경계
# ══════════════════════════════════════════════════════════════════
rect(CX, CY, CW, CH, fill=CLOUDBG)
dbox(CX, CY, CW, CH)
rrect(CX + 14, CY + 13, 36, 27, r=4, fill=NAVY)
text("aws", CX + 32, CY + 27, 12.5, "B", WHITE, anchor="mm")
text("AWS Cloud (us-east-1)", CX + 60, CY + 18, 15.5, "B", INK)

# ── 사용자 ────────────────────────────────────────────────────────
ux, uy = 46, 292
ell(ux + 18, uy, ux + 46, uy + 28, outline=INK, width=2)
arc(ux + 4, uy + 26, ux + 60, uy + 74, 180, 360, INK, 2)
poly([(ux + 6, uy + 78), (ux + 58, uy + 78), (ux + 64, uy + 92), (ux, uy + 92)],
     outline=INK, width=2)
text("사용자", ux + 32, uy + 102, 14, "B", INK, anchor="ma")
text("웹 브라우저", ux + 32, uy + 122, 11.5, "R", GREY, anchor="ma")

# ── CloudFront ────────────────────────────────────────────────────
svc(CF, CFT, NET, gl_cloudfront, "Amazon CloudFront",
    ("d2cmff9bta4e7l.cloudfront.net", "오리진 2개 · OAC SigV4", "WAF 부착 · TLS 1.2+"))
_hx0, _hx1 = ux + 78, CF - ISZ / 2 - 8
arrow(_hx0, CFT + 27, _hx1, CFT + 27, INK, 1.8)
text("HTTPS", (_hx0 + _hx1) / 2, CFT + 2, 12.5, "M", INK, anchor="ma")
badge((_hx0 + _hx1) / 2, CFT + 48, 1)

# ── 경로 분기 버스 ─────────────────────────────────────────────────
line(CF + ISZ / 2, CFT + 27, BUS, CFT + 27, INK, 1.6)
line(BUS, S3Y, BUS, AGY, INK, 1.6)

# ── S3 (정적 갈래) ────────────────────────────────────────────────
svc(COL2, S3Y - 27, STOR, gl_s3, "Amazon S3",
    ("React 정적 파일", "버킷 완전 비공개"))
arrow(BUS, S3Y, COL2 - ISZ / 2 - 8, S3Y, INK, 1.6)
text("/*", BUS + 10, S3Y - 24, 13, "B", GREY)
badge(BUS + 64, S3Y, 2)

# ── API Gateway (API 갈래) ────────────────────────────────────────
svc(COL2, AGY - 27, NET, gl_apigw, "Amazon API Gateway",
    ("HTTP API · AWS_PROXY", "통합 타임아웃 30초"))
arrow(BUS, AGY, COL2 - ISZ / 2 - 8, AGY, RED, 1.6)
text("/api/*", BUS + 10, AGY - 52, 13, "B", RED)
text("x-origin-secret 주입", BUS + 10, AGY - 33, 10.5, "M", RED)
badge(BUS + 64, AGY, 3)

# ── Lambda ────────────────────────────────────────────────────────
svc(LM, AGY - 27, COMP, gl_lambda, "AWS Lambda",
    ("bookbot-api", "Node 22 · arm64 · 1024MB", "예약 동시성 10 · 타임아웃 90초"))
arrow(COL2 + ISZ / 2 + 8, AGY, LM - ISZ / 2 - 8, AGY, RED, 1.6)
badge((COL2 + LM) / 2, AGY, 4)

# ── 관측 · 비용 방어 (요청 경로 밖) ────────────────────────────────
rrect(OX, OY, OW, OH, r=6, fill=WHITE, outline=LGREY, width=1.2)
text("관측 · 비용 방어 — 요청 경로 밖에서 항상 동작", OX + 16, OY + 11, 12.5, "B", GREY)
for i, (c, g, t, s) in enumerate([
        (SEC,  gl_waf,        "AWS WAF",    "5분당 300회 / chat 100회"),
        (MGMT, gl_cloudwatch, "CloudWatch", "구조화 로그 · 알람 4종"),
        (MGMT, gl_budgets,    "Budgets",    "$100 / Bedrock $50"),
        (SEC,  gl_lock,       "IAM · KMS",  "최소 권한 · SSM 경유만")]):
    svc_row(OX + 18 + (i % 2) * 252, OY + 50 + (i // 2) * 46, c, g, t, s,
            isz=34, tsz=12.5, ssz=10)

# ══════════════════════════════════════════════════════════════════
# 관리형 서비스 (클라우드 경계 오른쪽)
# ══════════════════════════════════════════════════════════════════
rrect(MX, MY, MW, MH, r=8, fill=WHITE, outline=LGREY, width=1.4)
text("Lambda 가 호출하는 관리형 서비스", MX + 20, MY + 15, 13, "B", GREY)

line(LM + ISZ / 2 + 8, AGY, MBUS, AGY, GREY, 1.4)
line(MBUS, AGY, MBUS, MY + 76, GREY, 1.4)
text("AWS SDK 직접 호출 · IAM 역할 인증 — 관리할 API 키 없음",
     (LM + ISZ / 2 + 8 + MBUS) / 2, AGY - 20, 10.5, "M", GREY, anchor="ma")

for i, (c, g, t, s1, s2, n) in enumerate([
        (AI,   gl_bedrock,  "Amazon Bedrock",  "Claude Sonnet 4.6",
         "ConverseStream · 도구 사용 · 반복 3회", 6),
        (DB,   gl_dynamodb, "Amazon DynamoDB", "테이블 1개 · 4용도",
         "세션 · 캐시 · 레이트리밋 · 기록 (TTL)", 8),
        (MGMT, gl_ssm,      "Parameter Store", "도서 API 키 5개",
         "SecureString · 5분 캐시", 5)]):
    cy = MY + 76 + i * 72
    arrow(MBUS, cy, MX - 6, cy, GREY, 1.4)
    badge(MX + 20, cy, n, r=10)
    icon(MX + 40, cy - 22, 44, c, g)
    text(t,  MX + 96, cy - 22, 13.5, "B", INK)
    text(s1, MX + 96, cy - 3,  11,   "M", INK)
    text(s2, MX + 96, cy + 13, 10.5, "R", GREY)
    if i < 2:
        line(MX + 16, cy + 36, MX + MW - 16, cy + 36, FAINT, 1)

# ══════════════════════════════════════════════════════════════════
# 외부 인터넷 — 도서 API 6곳
# ══════════════════════════════════════════════════════════════════
rect(EX, EY, EW, EH, fill=EXTBG)
dbox(EX, EY, EW, EH, EXTLN, 1.3)
text("외부 인터넷 — 서점 · 도서관 · 무료전자책 6곳", EX + 16, EY + 12, 14.5, "B", EXTLN)
text("병렬 호출 (Promise.allSettled) · 한 곳이 죽어도 나머지로 답변 · 타임아웃 5초 · 응답 6시간 캐시",
     EX + 16, EY + 34, 11.5, "R", GREY)

srcs = [("알라딘",         "국내 서점",     "표지 · 신간 · 구매",   True),
        ("국립중앙도서관", "국내 납본기관", "국내 출간물 전량",     True),
        ("Google Books",  "종합",         "커버리지 1위 · 표지",  False),
        ("Open Library",  "종합",         "주제 분류 · 무료전문", False),
        ("Hardcover",     "커뮤니티",      "평점 · 무드 태그",     False),
        ("Gutendex",      "무료 전자책",   "저작권 만료 고전",     False)]
sw = (EW - 32 - 5 * 8) / 6
for i, (n, r, m, ko) in enumerate(srcs):
    x = EX + 16 + i * (sw + 8)
    rrect(x, EY + 58, sw, 74, r=5, fill=WHITE,
          outline=(RED if ko else LGREY), width=(1.4 if ko else 1.1))
    text(n, x + sw / 2, EY + 68, 13, "B", INK, anchor="ma")
    text(r, x + sw / 2, EY + 89, 10.5, "M", RED if ko else GREY, anchor="ma")
    text(m, x + sw / 2, EY + 106, 10, "R", GREY, anchor="ma")

# ── Lambda → 외부 (관측 상자 오른쪽 빈 공간을 지나 내려갑니다) ───────
line(LM, AGY + 110, LM, EY - 16, EXTLN, 1.7)
arrow(LM, EY - 16, LM, EY - 6, EXTLN, 1.7)
badge(LM, AGY + 136, 7)
text("6곳 동시 조회",             LM + 22, AGY + 158, 12,   "B", EXTLN)
text("ISBN13 으로 중복 제거",     LM + 22, AGY + 178, 10.5, "R", GREY)
text("제목 0.7 / 저자 0.5 대조",  LM + 22, AGY + 195, 10.5, "R", GREY)

# ── 30초 제약이 설정을 결정한 지점 (빈 공간에 배치) ─────────────────
NBX, NBY, NBW, NBH = 912, OY, 188, OH
rrect(NBX, NBY, NBW, NBH, r=6, fill=(253, 247, 246), outline=(228, 190, 186), width=1.2)
text("30초 제약이 정한 값", NBX + 14, NBY + 12, 11.5, "B", RED)
text("Bedrock 왕복을 API Gateway\n통합 타임아웃 30초 안에\n끝내야 합니다.\n\n배포 스크립트가 도구 반복을\n코드 기본값 4 → 3 으로 낮춥니다.",
     NBX + 14, NBY + 32, 10, "R", GREY, spacing=1.50)

# ══════════════════════════════════════════════════════════════════
# 흐름 범례
# ══════════════════════════════════════════════════════════════════
rrect(LX, LY, LW, LH, r=8, fill=WHITE, outline=LGREY, width=1.4)
text("요청 한 건이 지나는 길", LX + 20, LY + 15, 13, "B", GREY)
for i, (a, b) in enumerate([
        ("브라우저 → CloudFront",     "HTTPS · 유일한 공개 진입점"),
        ("CloudFront → S3",          "OAC SigV4 · 버킷 완전 비공개"),
        ("CloudFront → API Gateway", "/api/* · 오리진 비밀 헤더 주입"),
        ("API Gateway → Lambda",     "AWS_PROXY · 통합 타임아웃 30초"),
        ("Lambda → Parameter Store", "도서 API 키 5개 (5분 캐시)"),
        ("Lambda → Bedrock",         "정책 의도 분류 + 도구 루프"),
        ("Lambda → 도서 API 6곳",     "병렬 · 부분 실패 허용"),
        ("Lambda → DynamoDB",        "세션 · 캐시 · 레이트리밋 · 기록")]):
    y = LY + 50 + i * 50
    badge(LX + 32, y, i + 1, r=11)
    text(a, LX + 56, y - 12, 12.5, "B", INK)
    text(b, LX + 56, y + 4,  11,   "R", GREY)

# ══════════════════════════════════════════════════════════════════
# 바닥 5개 축
# ══════════════════════════════════════════════════════════════════
rrect(PX, PY, PW, PH, r=8, fill=PILLBG, outline=LGREY, width=1.2)
cw = PW / 5
for i, (c, g, t, b) in enumerate([
        (SEC,  gl_lock,       "보안",      "버킷 완전 비공개 · OAC SigV4\n오리진 비밀 헤더 · 최소 권한 IAM"),
        (MGMT, gl_budgets,    "비용 방어",  "레이트리밋 10/분 · WAF 300/5분\n예약 동시성 10 · Budgets $100"),
        (AI,   gl_check,      "환각 방어",  "도서 API 6곳으로 존재 대조\n제목 0.7 / 저자 0.5 통과만 카드로"),
        (MGMT, gl_cloudwatch, "관측성",     "구조화 JSON 로그 · 알람 4종\n/api/health 로 배포값 확인"),
        (COMP, gl_lambda,     "배포",      "CloudShell · 재실행 안전 스크립트 21개\n자동 검증 474건")]):
    x = PX + i * cw
    if i:
        line(x, PY + 20, x, PY + PH - 20, LGREY, 1)
    icon(x + 22, PY + 30, 40, c, g)
    text(t, x + 74, PY + 31, 15, "B", INK)
    text(b, x + 74, PY + 56, 11.5, "R", GREY, spacing=1.48)

# ── 꼬리말 ────────────────────────────────────────────────────────
rrect(40, 1058, 46, 26, r=4, fill=NAVY)
text("aws", 63, 1071, 12.5, "B", WHITE, anchor="mm")
text("BookBot · 2026 · 수치는 config.mjs · policy.mjs · /api/health 와 대조한 값입니다",
     98, 1064, 11.5, "R", GREY)

os.makedirs("docs", exist_ok=True)
img.resize((W, H), Image.LANCZOS).save(OUT, "PNG", optimize=True)
print(f"저장: {OUT}  {W}x{H}  {os.path.getsize(OUT):,} bytes")
