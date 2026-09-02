# 03. 도서 API 6종 — 키 발급과 연동 전략

> 추가 후보(정보나루·네이버·카카오·ISBNdb) 조사는 [9번 절](#9-추가-검토한-도서-api--무엇을-더-붙일-수-있는가)에 있습니다.

## 왜 5개나 쓰는가

하나로는 안 되기 때문입니다. 각 API가 가진 것과 없는 것이 정확히 갈립니다.

| | Google Books | Open Library | Gutendex | Hardcover | 알라딘 |
|---|---|---|---|---|---|
| 커버리지 | ★★★★★ | ★★★★☆ | ★★☆☆☆ (고전만) | ★★★☆☆ | ★★★☆☆ (국내) |
| 한국어 도서 | ★★★★☆ | ★★☆☆☆ | ✗ | ★☆☆☆☆ | **★★★★★** |
| 표지 이미지 | ★★★★★ | ★★★★☆ | ★★☆☆☆ | ★★★★☆ | **★★★★★** (국내서) |
| 주제/분류 태그 | ★★★☆☆ | ★★★★★ | ★★★☆☆ | ★★★★☆ | ★★★★☆ (국내 분류) |
| **정서적 무드 태그** | ✗ | ✗ | ✗ | **★★★★★** | ✗ |
| **콘텐츠 경고** | ✗ | ✗ | ✗ | **★★★★★** | ✗ |
| 커뮤니티 평점 | ★★☆☆☆ | ★★★☆☆ | ✗ | ★★★★★ | ★★☆☆☆ (표본 수 없음) |
| **원문 다운로드** | △ | ★★★☆☆ (IA 뷰어) | **★★★★★ (EPUB/TXT)** | ✗ | ✗ |
| **국내 구매 링크** | ✗ | ✗ | ✗ | ✗ | **★★★★★** |
| 신간 정렬 | △ | ✗ | ✗ | △ | **★★★★★** |
| API 키 필요 | ✅ | ✗ | ✗ | ✅ | ✅ (TTB 키) |
| 안정성 | ★★★★★ | ★★★★☆ | **★★☆☆☆** | ★★★★☆ | ★★★★☆ |

핵심은 **Hardcover의 무드 태그**입니다.
"요즘 지쳤는데 위로되는 책"이라는 요청에 진짜로 답하려면
`moods: ["reflective", "emotional", "hopeful"]` 같은 데이터가 필요합니다.
Google Books의 `categories: ["Fiction"]`으로는 불가능합니다.

그리고 **알라딘이 한국어 도서의 공백을 메웁니다.**
영어권 4종은 국내 신간·번역서를 거의 모릅니다. "요즘 나온 한국 소설"을 물으면
예전에는 고전이나 영문판만 나왔습니다. 알라딘 절은 [8번](#8-알라딘-국내-도서-api)입니다.

---

# 1. Google Books API — 키 발급

## 1-A. Google Cloud 프로젝트 만들기

1. [console.cloud.google.com](https://console.cloud.google.com) 접속 (구글 계정으로 로그인)
2. 상단 프로젝트 선택기 → **새 프로젝트**
   - 프로젝트 이름: `bookbot`
   - **만들기** → 생성될 때까지 10~20초 대기
3. 상단 프로젝트 선택기에서 방금 만든 `bookbot`을 선택 (중요 — 다른 프로젝트에 설정하면 안 됨)

## 1-B. Books API 사용 설정 ★ 이걸 안 하면 403

1. 좌측 메뉴 → **API 및 서비스** → **라이브러리** (Library)
2. 검색창에 `Books API` 입력
3. **Google Books API** 클릭 → **사용** (Enable) 버튼

> 이 단계를 건너뛰고 키만 만들면 `403 SERVICE_DISABLED`가 납니다.
> 가장 흔한 실수입니다.

## 1-C. API 키 만들기

1. 좌측 메뉴 → **API 및 서비스** → **사용자 인증 정보** (Credentials)
2. 상단 **+ 사용자 인증 정보 만들기** → **API 키**
3. 생성된 키(`AIza...`)를 복사 → **키 제한** 클릭

## 1-D. 키 제한 설정 (보안상 중요)

제한 없는 키가 유출되면 다른 Google API까지 남용될 수 있습니다.

| 항목 | 설정 |
|---|---|
| 이름 | `bookbot-books-api-key` |
| **애플리케이션 제한사항** | **없음** ← Lambda는 고정 IP가 없어서 IP 제한을 쓸 수 없습니다 |
| **API 제한사항** | **키 제한** 선택 → 목록에서 **Google Books API만** 체크 |

**저장**

> "애플리케이션 제한사항 없음"이 불편하면 Lambda를 VPC + NAT Gateway에 넣고
> Elastic IP를 고정해 IP 제한을 걸 수 있습니다.
> 다만 NAT Gateway는 **시간당 약 $0.059 + 데이터 처리 요금**이라
> 2주면 $20 정도 추가됩니다. 실습 규모에는 과합니다.
> 대신 **API 제한사항으로 Books API만 허용**해두면 유출 시 피해가 이 API로 한정됩니다.

## 1-E. 쿼터 확인

**API 및 서비스** → **Google Books API** → **할당량 및 시스템 한도**

기본값은 **1일 1,000회**입니다. 이 프로젝트는 DynamoDB 캐시를 쓰므로
2주 데모라면 충분합니다. 부족하면 같은 화면에서 증량을 요청할 수 있습니다.

## 1-F. 즉시 테스트

```bash
curl -s "https://www.googleapis.com/books/v1/volumes?q=intitle:%EC%86%8C%EB%85%84%EC%9D%B4%20%EC%98%A8%EB%8B%A4&country=KR&key=YOUR_KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('총',d.get('totalItems'),'건'); [print('-',i['volumeInfo']['title']) for i in d.get('items',[])[:3]]"
```

### ⚠️ Lambda에서만 터지는 함정 — `country` 파라미터

로컬 PC에서는 잘 되던 호출이 Lambda에 올리면 이렇게 실패합니다:

```json
{ "error": { "code": 403, "errors": [{ "reason": "unknownLocation" }] } }
```

Google이 호출자의 국가를 판별할 수 없을 때 발생합니다.
Lambda의 egress IP는 AWS 데이터센터라 위치 추정이 안 되는 경우가 있습니다.

**해결: `country=KR`을 항상 붙입니다.** 코드에 이미 반영돼 있습니다
(`src/tools/googleBooks.mjs`).

---

# 2. Hardcover API — 토큰 발급

이 프로젝트에서 **추천 품질을 가장 크게 끌어올리는 소스**입니다.

## 2-A. 계정 만들고 토큰 받기

1. [hardcover.app](https://hardcover.app) 접속 → 회원가입 (무료)
2. 로그인 후 [hardcover.app/account/api](https://hardcover.app/account/api) 로 이동
3. 표시된 토큰을 **그대로 전체 복사**

## 2-B. 토큰 형식 주의 ★

토큰이 `Bearer eyJhbGci...` 처럼 **`Bearer ` 접두사를 포함해서** 나올 수 있습니다.

- 그대로 SSM에 넣어도 됩니다. 코드가 정규화합니다
  (`src/tools/hardcover.mjs`의 `normalizeToken()`)
- 직접 curl로 테스트할 때는 `Bearer Bearer ey...`가 되지 않게 주의하세요

## 2-C. 제약사항 (설계에 영향을 줍니다)

| 항목 | 값 | 이 프로젝트에서의 대응 |
|---|---|---|
| 레이트리밋 | **60 요청/분** | DynamoDB 캐시(6시간) + 재시도 1회로 제한 |
| 최대 쿼리 깊이 | **3** | `search { ids results }` = 깊이 2로 안전하게 유지 |
| 토큰 유효기간 | 약 1년 | 2주 데모에는 문제 없음 |
| 타임아웃 | 30초 | 우리 쪽에서 6초로 더 짧게 자름 |

## 2-D. GraphQL 구조 이해

Hardcover는 검색 백엔드로 **Typesense**를 씁니다.
그래서 `results`가 정형 GraphQL 타입이 아니라 **JSON 스칼라**로 내려옵니다.

```graphql
query BookBotSearch($q: String!, $type: String!, $perPage: Int!) {
  search(query: $q, query_type: $type, per_page: $perPage, page: 1) {
    ids
    results          # ← 여기가 { found, hits: [{ document: {...} }] } 형태의 JSON
  }
}
```

`document` 안에서 우리가 쓰는 필드:

| 필드 | 용도 |
|---|---|
| `title`, `subtitle`, `author_names`, `release_year`, `pages` | 기본 서지 |
| `isbns` | **4개 소스를 병합하는 조인 키** |
| `rating`, `ratings_count`, `users_read_count` | 신뢰도 판단 |
| **`moods`** | ★ "이런 분위기 책" 요청의 근거 |
| **`genres`** | ★ 독자가 붙인 실제 장르 (출판사 분류보다 정확) |
| **`content_warnings`** | ★ 사전 경고 — 배려 있는 추천 |
| `featured_series`, `series_names`, `featured_series_position` | 다음 권 추천 |
| `has_audiobook`, `has_ebook` | 이용 형태 |
| `image.url` | 표지 |
| `slug` | `hardcover.app/books/{slug}` 링크 |

## 2-E. 즉시 테스트

```bash
TOKEN="여기에_토큰"   # 'Bearer ' 접두사가 있으면 제거하고 넣으세요

curl -s https://api.hardcover.app/v1/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { search(query: \"pride and prejudice\", query_type: \"Book\", per_page: 3, page: 1) { results } }"}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'errors' in d:
    print('오류:', d['errors']); raise SystemExit(1)
hits = d['data']['search']['results'].get('hits', [])
for h in hits:
    doc = h['document']
    print('-', doc.get('title'), '| 평점', doc.get('rating'),
          '| 무드', doc.get('moods'), '| 장르', doc.get('genres'))
"
```

무드 배열이 찍히면 성공입니다. 이 데이터가 챗봇 답변의 근거가 됩니다.

## 2-F. Hardcover는 GraphiQL 탐색기를 제공합니다

[api.hardcover.app](https://api.hardcover.app) 에서 브라우저로 쿼리를 시험해볼 수 있습니다.
필드를 추가하고 싶을 때 여기서 먼저 확인하세요. (Authorization 헤더 입력란이 있습니다)

---

# 3. Open Library — 키 불필요

## 3-A. 발급 절차 없음

인증 없이 바로 씁니다. 단, **예의**가 요구됩니다.

### ⚠️ User-Agent를 반드시 보내세요

Open Library는 정체를 밝히지 않는 요청을 차단합니다.
연락처가 담긴 User-Agent가 없으면 403 또는 429를 받습니다.

```
User-Agent: BookBot/1.0 (AWS workshop project; your-email@example.com)
```

코드에서는 `src/lib/http.mjs`가 모든 요청에 자동으로 붙입니다.
**Lambda 환경 변수 `CONTACT_EMAIL`에 본인 이메일을 넣으세요.**
(안 넣으면 예시 주소가 들어가는데, 대량 호출 시 차단될 수 있습니다)

## 3-B. 이 프로젝트에서 쓰는 3개 엔드포인트

**① 일반 검색** — `fields`로 응답 크기를 줄이는 게 중요합니다

```bash
curl -s -A "BookBot/1.0 (test; me@example.com)" \
 "https://openlibrary.org/search.json?q=김초엽&fields=key,title,author_name,first_publish_year,cover_i,isbn,subject,ratings_average,ebook_access&limit=5" \
 | python3 -m json.tool | head -40
```

> `fields`를 지정하지 않으면 권당 수십 KB가 옵니다. Lambda 메모리와 시간 낭비입니다.

**② 주제별 탐색** — 무드성 요청에 강력합니다

```bash
curl -s -A "BookBot/1.0 (test; me@example.com)" \
 "https://openlibrary.org/subjects/detective_and_mystery_stories.json?limit=5" \
 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['name'], d['work_count']); [print('-',w['title']) for w in d['works'][:5]]"
```

쓸만한 subject 슬러그:
```
science_fiction          fantasy               historical_fiction
detective_and_mystery_stories                  horror
love                     humor                 poetry
philosophy               psychology            self-help
biography                travel                cooking
short_stories            young_adult_fiction   graphic_novels
```

**③ 무료 전문 검색** — Gutendex 장애 시 폴백

```bash
curl -s -A "BookBot/1.0 (test; me@example.com)" \
 "https://openlibrary.org/search.json?q=austen&has_fulltext=true&ebook_access=public&fields=title,author_name,ia,ebook_access&limit=3" \
 | python3 -m json.tool
```

`ebook_access` 값의 의미:

| 값 | 의미 |
|---|---|
| `public` | **즉시 무료 열람 가능** (우리가 원하는 것) |
| `borrowable` | Internet Archive 계정으로 대출 필요 |
| `printdisabled` | 인쇄 장애인만 |
| `no_ebook` | 전자책 없음 |

## 3-C. 표지 이미지 URL 규칙

```
https://covers.openlibrary.org/b/id/{cover_i}-L.jpg      # 검색 결과의 cover_i 사용
https://covers.openlibrary.org/b/isbn/{isbn13}-L.jpg     # ISBN으로도 가능
```
크기: `S`(소) / `M`(중) / `L`(대). 별도 API 호출 없이 URL만 만들면 됩니다.

---

# 4. Gutendex (Project Gutenberg) — 키 불필요, 다만 불안정

## 4-A. 발급 절차 없음

## 4-B. ⚠️ 반드시 알아야 할 안정성 문제

**이 프로젝트를 만들면서 실제로 확인한 사항입니다.**

```
$ curl -s -w "%{http_code} %{time_total}s\n" "https://gutendex.com/books?search=austen"
301 25.5s        ← /books/ 로 리다이렉트한 뒤 응답 없음

$ curl -s -w "%{http_code}\n" "https://gutendex.com/books?search=austen&copyright=false"
503              ← Service Unavailable
```

Gutendex 공식 문서에도 이렇게 적혀 있습니다 — *장기적으로 사용할 거면 직접 서버를 운영하라.*
공개 인스턴스는 개인이 무료로 제공하는 것이라 트래픽이 몰리면 죽습니다.
시점에 따라 Cloudflare 챌린지로 403이 나올 수도 있습니다.

### 코드에 넣은 3중 방어

| 방어 | 내용 | 위치 |
|---|---|---|
| ① 리다이렉트 회피 | `/books` 대신 **`/books/`** 로 호출 (301 홉 제거) | `gutendex.mjs` |
| ② 짧은 타임아웃 + 미러 페일오버 | 4초 타임아웃, 재시도 1회. `GUTENDEX_BASE_URLS`에 미러를 콤마로 넣으면 순차 시도 | `gutendex.mjs` |
| ③ 기능 폴백 | 전부 실패하면 **Open Library 무료 전문 검색**으로 자동 대체 | `tools/index.mjs` |

③ 덕분에 gutendex.com이 죽어 있어도 "무료로 읽을 수 있는 책" 기능이 살아있습니다.
로컬 테스트로 확인했습니다:

```
PASS Gutendex 검색 — ⚠ gutendex.com 응답 없음 → 폴백 경로로 대체됩니다
PASS 무료 전자책 폴백 — Open Library 폴백 3건 / "Pride and Prejudice" → https://archive.org/details/...
```

## 4-C. 정상일 때의 사용법

```bash
curl -s "https://gutendex.com/books/?search=austen&languages=en&sort=popular&copyright=false" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('총', d['count'], '건')
for b in d['results'][:3]:
    fmts = b['formats']
    epub = next((v for k,v in fmts.items() if k.startswith('application/epub')), None)
    print('-', b['title'], '|', b['authors'][0]['name'] if b['authors'] else '?',
          '| 다운로드', b['download_count'], '\n   EPUB:', epub)
"
```

파라미터 (공식 문서 확인):

| 파라미터 | 설명 |
|---|---|
| `search` | 제목+저자 검색 (공백 구분, 대소문자 무시) |
| `topic` | 서가/주제 키프레이즈. 예: `detective`, `philosophy`, `adventure` |
| `languages` | 2자 코드 콤마 구분. 예: `en`, `en,fr` |
| `sort` | `popular`(기본, 다운로드순) / `ascending` / `descending` |
| `copyright` | `false` = 미국 기준 퍼블릭 도메인만 = **확실히 무료** |
| `ids` | Gutenberg ID 콤마 구분 |
| `author_year_start` / `author_year_end` | 저자 생존 연도 범위 |

`formats` 응답 구조 — **MIME 타입이 키**입니다:
```json
{
  "text/html": "https://www.gutenberg.org/ebooks/1342.html.images",
  "application/epub+zip": "https://www.gutenberg.org/ebooks/1342.epub3.images",
  "text/plain; charset=us-ascii": "https://www.gutenberg.org/ebooks/1342.txt.utf-8",
  "image/jpeg": "https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg"
}
```
`text/plain; charset=...` 처럼 파라미터가 붙으니 **정확 일치가 아니라 `startsWith`로 매칭**해야 합니다.
(`gutendex.mjs`의 `pickFormats()`)

## 4-D. (선택) Gutendex 자체 호스팅 — 2주 안정 운영을 원한다면

Gutendex는 오픈소스 Django 앱입니다. AWS에 직접 올리면 안정성이 해결됩니다.
다만 **이 실습의 범위를 넘어갑니다** (RDS PostgreSQL + ECS/EC2 + 야간 카탈로그 동기화 배치).

비용 감각: `db.t4g.micro` RDS + `t4g.small` EC2 = 2주에 약 **$15~20**.
2주 데모라면 폴백으로 충분합니다.
**"확장 과제"로 남겨두기 좋은 주제입니다.**

---

# 5. 연동 전략 — 5개를 어떻게 합치는가

## 5-1. 역할 분담 (가장 중요한 설계 결정)

4개를 전부 매번 호출하는 게 아닙니다. **요청 유형에 따라 다른 조합을 씁니다.**

```
사용자 발화
   │
   ├─ "김초엽 작가 책 알려줘"        → search_books
   │                                   Google Books + Open Library + Hardcover 병렬
   │                                   + 알라딘 (한글이 있거나 language='ko' 일 때만)
   │
   ├─ "지쳤는데 위로되는 소설"        → browse_by_subject
   │                                   Open Library subject + Hardcover mood + Google Books
   │                                   + 알라딘 (language='ko' 일 때만)
   │
   ├─ "무료로 읽을 고전"             → find_free_ebooks
   │                                   Gutendex (→ 실패 시 Open Library 무료전문) + Hardcover 보강
   │                                   (알라딘은 무료 전문을 제공하지 않아 제외)
   │
   └─ "그 책 몇 페이지야?"           → get_book_detail
                                       4개 전부 + 알라딘(한글 제목·ISBN 조회)
```

**알라딘을 항상 부르지 않는 이유**: 영어 질문에 국내 서점을 조회하면
지연만 늘고 결과는 안 늘어납니다. 호출 조건은 [8-D](#8-d-언제-호출하는가--항상-부르지-않습니다).

LLM이 도구 설명을 읽고 **스스로 판단**합니다 (`tools/index.mjs`의 `description`).
그래서 도구 설명을 잘 쓰는 게 코드보다 중요합니다.

## 5-2. ISBN-13 조인 — 병합의 기술적 핵심

같은 책을 4개 소스가 다르게 표현합니다:

```
Google Books  industryIdentifiers: [{type:'ISBN_10', identifier:'0141439513'},
                                     {type:'ISBN_13', identifier:'9780141439518'}]
Open Library  isbn: ['0141439513', '9780141439518', '0192833558', ...]
Hardcover     isbns: ['9780141439518', ...]
Gutendex      (ISBN 없음)
```

**2단계 매칭으로 해결합니다:**

```
1단계  전부 ISBN-13으로 정규화 → 정확 매칭
       (ISBN-10 체크digit과 ISBN-13 체크digit은 계산식이 달라서 변환이 필요합니다.
        0141439513 → 9780141439518. 단순히 앞에 978을 붙이면 틀립니다)

2단계  ISBN이 없는 책(Gutenberg)은 fuzzy 키로 매칭
       제목 소문자화 → 발음구별기호 제거 → 관사(the/a/an) 제거 → 특수문자 제거
       + 첫 저자 정규화
       "The Remains of the Day" + "Kazuo Ishiguro"
         → "T:remainsofday|A:kazuoishiguro"
```

구현: `src/lib/isbn.mjs`, `src/tools/merge.mjs`

## 5-3. 필드별 우선순위 — "어느 소스를 믿을까"

병합할 때 필드마다 신뢰할 소스가 다릅니다.

| 필드 | 우선순위 | 근거 |
|---|---|---|
| 표지 | Google Books → Hardcover → Open Library → Gutendex | 해상도와 존재율 |
| 설명 | **가장 긴 것** | 정보량 |
| 평점 | Hardcover → Open Library → Google Books | 커뮤니티 규모와 신뢰도 |
| 무드 / 콘텐츠 경고 | **Hardcover 전용** | 다른 곳에 없음 |
| 무료 전문 | Gutendex → Internet Archive → Google Books | 실제 파일을 주는 순서 |
| 페이지 수 | Google Books → Hardcover → Open Library | 판본 정확도 |

구현: `merge.mjs`의 `pickCover()`, `pickRating()`, `pickFreeEbook()`

## 5-4. 정렬 점수 — "여러 소스가 아는 책"을 위로

```js
점수 = 소스 개수 × 12          // 교차 검증된 책 = 실제로 유명하고 구하기 쉬운 책
     + (표지 있으면 8)          // UI 품질
     + 평점 × 3
     + (평가 100명 이상 5)
     + (무드 있으면 6)          // 추천 근거를 댈 수 있음
     + (무료 전문 4)
     + (설명 있으면 3)
```

**"3개 DB가 동시에 아는 책"은 좋은 추천 후보라는 신호**입니다.
반대로 한 곳에만 있는 책은 절판이거나 마이너할 가능성이 큽니다.

## 5-5. ★ 이중 채널 — 토큰 비용을 10분의 1로

이 프로젝트에서 **가장 실용적인 아이디어**입니다.

```
도구 실행 결과 (전체 레코드, 권당 ~1200 토큰)
    │
    ├──▶ LLM 에게:      압축 요약만 (권당 ~110 토큰)
    │                    제목/저자/연도/평점/장르/무드/경고만
    │                    → 판단에 필요한 최소 정보
    │
    └──▶ 프론트엔드에게: 전체 레코드 (SSE 'books' 이벤트)
                         표지 URL, 긴 설명, 모든 링크
                         → LLM을 거치지 않고 직행
```

**측정 결과 (로컬 테스트):**
```
전체 61,755자 → 압축 779자 (99% 절감)
```

효과:
- **입력 토큰 비용 대폭 감소** (Bedrock 요금의 상당 부분이 입력 토큰)
- **응답 속도 향상** (LLM이 읽을 양이 적음)
- **표지가 즉시 렌더** (LLM 응답을 기다리지 않음 → 체감 속도)
- **환각 불가** (표지 URL을 LLM이 만들 기회가 없음)

구현: `merge.mjs`의 `compactForLlm()`, `agent.mjs`의 `emit({type:'books'})`

## 5-6. 부분 실패 허용 (`Promise.allSettled`)

```js
const results = await Promise.allSettled([
  searchGoogleBooks(...),   // 429 쿼터 초과 가능
  searchOpenLibrary(...),   // 429 UA 차단 가능
  searchHardcover(...),     // 60/min 초과 가능
]);
// 하나가 죽어도 나머지로 답한다
return mergeBooks(results.map(unwrap), limit);
```

`Promise.all`을 쓰면 **하나만 실패해도 전체가 실패**합니다.
무료 공개 API를 4개나 쓰는 구조에서는 반드시 `allSettled`를 써야 합니다.

실패한 소스는 CloudWatch에 남습니다:
```
fields @timestamp, tool, source, reason
| filter msg = "소스 실패 (나머지로 진행)"
```

## 5-7. 캐시 전략

| 도구 | 캐시 키 | TTL | 히트율이 높은 이유 |
|---|---|---|---|
| `search_books` | 정규화된 쿼리 + 언어 + 개수 | 6시간 | 같은 저자/키워드 반복 |
| `browse_by_subject` | subject + moodQuery | 6시간 | subject 종류가 유한함 → **매우 높음** |
| `find_free_ebooks` | query + topic + 언어 | 6시간 | Gutenberg 카탈로그는 거의 안 바뀜 |
| `get_book_detail` | ISBN 또는 제목+저자 | 6시간 | 인기 도서 반복 조회 |

DynamoDB 캐시 히트 = 5~15ms, 외부 API = 400~2000ms.
데모 중 쿼터가 마르는 것도 막아줍니다.

---

# 6. 확장 아이디어 (실습을 더 밀고 나가고 싶다면)

난이도와 비용 대비 효과 순으로 정렬했습니다.

### ★★★ 비용/효과가 가장 좋은 것

**1. 시리즈 다음 권 자동 추천**
Hardcover의 `featured_series` + `featured_series_position`을 이미 받아오고 있습니다.
"이 시리즈 다음 권" 도구를 추가하면 재방문율이 올라갑니다. 코드 20줄.

**2. 콘텐츠 경고 필터**
"자살 언급 없는 책만" 같은 요청을 처리합니다.
`content_warnings`로 후처리 필터를 걸면 됩니다.
접근성/배려 측면에서 **포트폴리오로서 인상적인 기능**입니다.

**3. 무드 기반 추천 근거 강화**
현재 무드를 프롬프트에 넘기고 있습니다. 여기서 한 걸음 더 나가서
사용자 발화의 감정을 무드 태그로 매핑하는 사전을 만들면
("지침" → `reflective, hopeful, emotional`) 추천 정확도가 눈에 띄게 올라갑니다.
LLM 호출 없이 되므로 비용 0.

### ★★ AWS 학습 효과가 큰 것

**4. Bedrock Knowledge Bases로 RAG 추가**
사용자가 좋아한 책의 설명을 임베딩해서 벡터 검색으로 유사 도서를 찾습니다.
**S3 Vectors**를 벡터 스토어로 쓰면 OpenSearch Serverless보다 훨씬 저렴합니다
(OpenSearch Serverless는 최소 용량 때문에 월 $100+가 나옵니다 — 실습에서 예산을 태우는 대표 함정).

**5. Step Functions로 야간 배치**
인기 subject의 검색 결과를 미리 캐시에 채워둡니다(cache warming).
첫 응답 속도가 개선되고, EventBridge Scheduler + Step Functions 학습이 됩니다.

**6. Cognito + 개인화**
사용자별 읽은 책/취향을 DynamoDB에 저장해 프롬프트에 넣습니다.
Hardcover API는 사용자 서재 조회도 지원하므로 계정 연동까지 가면 재미있습니다.

**7. Athena로 사용 패턴 분석**
CloudWatch Logs를 S3로 내보내고 Athena로 쿼리합니다.
"어떤 subject가 인기인가", "도구별 평균 응답 시간" 같은 분석.

### ★ 도전적인 것

**8. Gutendex 자체 호스팅** (4-D 참고)
안정성 문제를 근본적으로 해결. RDS + ECS + 배치 동기화 학습.

**9. 표지 이미지 최적화 파이프라인**
외부 표지 URL을 그대로 쓰면 로딩이 느리고 링크가 깨질 수 있습니다.
S3 + CloudFront + Lambda@Edge로 리사이즈/캐싱 파이프라인을 만듭니다.

**10. 멀티모달 — 책장 사진으로 추천**
사용자가 책장 사진을 올리면 Claude의 비전 기능으로 제목을 읽고,
그 취향을 분석해 다음 책을 추천합니다. Bedrock Converse는 이미지 입력을 지원합니다.

---

# 7. 키 발급 체크리스트

작업을 시작하기 전에 이것부터 통과시키세요.

```bash
cd backend
npm install
export GOOGLE_BOOKS_API_KEY="AIza..."
export HARDCOVER_TOKEN="eyJ..."
export ALADIN_TTB_KEY="ttb..."      # 국내 도서 (8번 절)
npm run smoke
npm run test:features               # 평가·알라딘·logRef 회귀 46건
```

기대 결과:

```
■ 0. 순수 로직 (네트워크 없음)
PASS ISBN-10 → ISBN-13 변환
PASS ISBN 후보 수집 (Google Books 형식)
PASS Google Books 쿼리 조립

■ 1. 외부 API 개별 연결
PASS Google Books 검색            ← 키가 유효하면 통과
PASS Open Library 검색
PASS Open Library 주제 탐색
PASS Gutendex 검색                ← 다운 시 "폴백으로 대체" 메시지 (정상)
PASS 무료 전자책 폴백
PASS Hardcover GraphQL 검색       ← 토큰이 유효하면 통과. 무드 태그가 찍혀야 함

■ 2. 다중 소스 병합
PASS ISBN 기준 병합 + 중복 제거    ← "2개 이상 소스에서 확인된 책 N권"에서 N>0 이어야 이상적
PASS LLM용 압축
```

| 항목 | 통과 기준 |
|---|---|
| Google Books 키 | `PASS`. `403`이면 Books API 사용 설정(1-B) 확인 |
| Hardcover 토큰 | `PASS` + **무드 태그가 출력됨**. `401`이면 토큰 형식 확인 |
| Open Library | `PASS`. `403`이면 `CONTACT_EMAIL` 설정 |
| Gutendex | `PASS` (다운이어도 폴백 메시지면 정상) |
| 알라딘 TTB 키 | 8-E 의 직접 테스트로 확인. **오류도 200이라 `PASS` 만 믿으면 안 됩니다** |
| 병합 | 2개 이상 소스에서 확인된 책이 1권 이상 → ISBN 조인이 동작하는 증거 |

여기까지 통과하면 [02-aws-console-setup.md](./02-aws-console-setup.md) STEP 3으로 가서
두 키를 SSM Parameter Store에 넣으세요.

---

# 8. 알라딘 국내 도서 API

영어권 4종만으로는 한국어 도서가 빈약합니다. 알라딘은 국내 서점 API라
**국내 신간·번역서·한국 문학**을 정확히 채웁니다.

## 8-A. TTB 키 받기

1. <https://www.aladin.co.kr/ttb/wblog_manage.aspx> 접속 (알라딘 회원 로그인 필요)
2. **TTB (Thanks To Blog)** 신청 — 블로그·사이트 주소를 적는 칸이 있습니다.
   CloudFront 주소(`https://CLOUDFRONT_DOMAIN_MASKED.cloudfront.net`)를 넣으면 됩니다.
3. 발급된 키는 `ttb` + 아이디 + 숫자 형식입니다. 예: `ttbexample1234001`
4. 승인은 보통 즉시입니다.

| 항목 | 값 |
|---|---|
| 호출 한도 | **하루 5,000회** (계정당) |
| 비용 | 무료 |
| 키 형식 | `ttb...` (24자 내외) |
| 필수 파라미터 | `TTBKey`, `Query`, `Output=js`, `Version=20131101` |

`Version=20131101`을 빼면 구버전 응답이 와서 필드가 다릅니다. **반드시 넣으세요.**

## 8-B. ★ 가장 큰 함정 — 오류도 HTTP 200으로 옵니다

이 API는 키가 틀려도 **HTTP 상태 코드 200**을 돌려줍니다.
오류는 본문 JSON 안에만 있습니다.

```json
{ "errorCode": 4, "errorMessage": "잘못된 TTBKey입니다." }
```

그래서 `if (!res.ok)` 만 검사하는 흔한 코드는 **오류를 성공으로 착각합니다.**
`tools/aladin.mjs`는 본문의 `errorCode`를 직접 확인합니다.

```javascript
// searchAladin() 안
if (json.errorCode) {
  log.warn('aladin_error', { errorCode: json.errorCode, errorMessage: json.errorMessage });
  return []; // 예외를 던지지 않습니다 — 나머지 4개 소스로 답이 나가야 하니까
}
```

**키가 없거나 틀려도 서비스는 정상 동작합니다.** 한국어 결과만 빈약해집니다.
그래서 배포 후에 키가 실제로 먹었는지는 로그로 확인해야 합니다 (8-E).

주요 `errorCode`:

| 코드 | 뜻 | 대응 |
|---|---|---|
| 4 | 잘못된 TTBKey | 키 오타 확인, SSM 값 재확인 |
| 8 | 필수 파라미터 누락 | `Query` 가 빈 문자열인지 확인 |
| 100 | 조회 결과 없음 | 정상. 빈 배열 반환 |
| 900 | 시스템 오류 / 한도 초과 | 하루 5,000회를 넘겼는지 확인 |

## 8-C. 응답 필드의 한국식 형식

영어권 API와 형식이 달라서 **정제 없이 쓰면 병합이 깨집니다.**

### `author` — 역할 표기가 붙어 있습니다

```
"한강 (지은이)"
"요한 하리 (지은이), 김하현 (옮긴이)"
```

이걸 그대로 저자로 쓰면 병합 키가 `A:한강지은이` 가 되어
Google Books의 `A:한강` 과 **다른 책으로 취급됩니다. 같은 책이 카드 2장으로 나옵니다.**

`parseAuthors()` 가 처리합니다.

```javascript
parseAuthors('요한 하리 (지은이), 김하현 (옮긴이)')
// → ['요한 하리', '김하현']   ← 역할 표기 제거 + 지은이를 앞으로
```

번역서는 옮긴이가 먼저 적혀 있는 경우도 있어서 **지은이/글/원작을 앞으로 정렬**합니다.
저자 순서가 뒤바뀌면 카드에 번역가가 저자로 표시됩니다.

### `categoryName` — `>` 로 구분된 계층

```
"국내도서>소설/시/희곡>한국소설>한국소설일반"
```

`parseCategories()` 가 `>` 로 쪼개고 맨 앞의 `국내도서`·`외국도서` 는 버립니다
(모든 책에 붙어 있어 정보가 없습니다).

### `customerReviewRank` — 0~10 정수

5점 만점으로 나누어 저장합니다 (`rank / 2`).
**표본 수(몇 명이 평가했는지)를 주지 않습니다.** 그래서 `merge.mjs` 의
`RATING_PRIORITY` 에서 알라딘을 **맨 뒤**에 놓았습니다. 3명이 준 5점과
2,000명이 준 4.2점을 구분할 수 없으면 신뢰할 수 없습니다.

### `pageCount` 는 기본 응답에 없습니다

`OptResult=packing` 을 붙여야 나오는데, 호출이 무거워지고 페이지 수는
추천 품질에 거의 영향이 없어서 **`null` 로 둡니다.**

### 표지는 `http://` 로 옵니다

HTTPS 페이지에서 `http` 이미지는 브라우저가 차단합니다(mixed content).
어댑터가 `https://` 로 강제 치환합니다.

## 8-D. 언제 호출하는가 — 항상 부르지 않습니다

영어 질문에 알라딘을 부르면 **지연만 늘고 결과는 안 늘어납니다.**

| 도구 | 알라딘 호출 조건 |
|---|---|
| `search_books` | 검색어에 **한글이 있거나** `language === 'ko'` |
| `browse_by_subject` | `language === 'ko'` 일 때만 (주제 슬러그는 영어라 한글 감지가 안 먹음) |
| `get_book_detail` | 제목에 한글이 있거나, ISBN 조회 |

```javascript
const wantKorean = language === 'ko' || hasHangul(plainQuery);
```

**캐시 키에 `wantKorean` 을 반드시 포함해야 합니다.** 같은 검색어라도
알라딘이 끼었는지에 따라 결과 구성이 달라지기 때문입니다. 빼먹으면
영어 사용자가 한국어 사용자의 캐시를 받습니다.

## 8-E. 즉시 테스트

배포 전 로컬:

```bash
cd backend
export ALADIN_TTB_KEY="ttb...키..."
node -e '
import("./src/tools/aladin.mjs").then(async (m) => {
  const r = await m.searchAladin({ query: "소년이 온다", key: process.env.ALADIN_TTB_KEY, limit: 3 });
  if (!r.length) return console.log("✗ 결과 0건 — 키를 확인하세요");
  for (const b of r) console.log(`✓ ${b.title} | ${b.authors.join(", ")} | ${b.publishedYear} | ${b.categories.join("/")}`);
});
'
```

기대 출력:

```
✓ 소년이 온다 | 한강 | 2014 | 소설/시/희곡/한국소설
```

저자에 `(지은이)` 가 남아 있으면 정제가 안 된 것입니다.

배포 후에는 **헬스체크가 가장 빠릅니다.** 키가 로드됐는지 한 줄로 나옵니다.

```bash
curl -s https://CLOUDFRONT_DOMAIN_MASKED.cloudfront.net/api/health | \
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("ALADIN_TTB_KEY:", d["secrets"]["ALADIN_TTB_KEY"]); [print("경고:",w) for w in d.get("warnings",[])]'
```

`ALADIN_TTB_KEY: True` 면 로드된 것입니다. `False` 면 SSM 파라미터 이름을 확인하세요.

> 헬스체크의 `warnings` 는 **서비스는 돌지만 품질이 떨어지는 상태**를 알려줍니다.
> 키가 없어도 `ok` 는 `true` 입니다 — 추천 자체는 나가기 때문입니다.

키가 로드됐는데도 한국어 결과가 안 나오면 실제 호출 로그를 봅니다.

```bash
aws logs tail /aws/lambda/bookbot-api --region us-east-1 --since 10m \
  --filter-pattern 'aladin'
```

`aladin_error` 가 보이면 키 문제입니다. 아무 로그도 없으면 호출 조건(8-D)에
안 걸린 것이니 **한글이 들어간 질문**으로 다시 시도하세요.

## 8-F. 회귀 테스트

파싱 규칙은 영구 테스트로 고정되어 있습니다.

```bash
cd backend && npm run test:features
```

`■ 알라딘` 절에서 저자 정제 5케이스, 카테고리 접두 제거,
오류 응답이 예외를 던지지 않는지, 한글 감지 4케이스를 확인합니다.

## 8-G. 키를 SSM에 넣기

```bash
aws ssm put-parameter --region us-east-1 \
  --name "/bookbot/prod/ALADIN_TTB_KEY" \
  --value "ttb...키..." --type SecureString --overwrite
```

`infra/01-backend.sh` 의 `put_param` 이 `secrets.env` 에서 자동으로 넣어주므로
보통은 직접 실행할 필요가 없습니다. IAM 은 `parameter/bookbot/prod/*` 와일드카드라
**새 키를 추가해도 권한 수정이 필요 없습니다.**

---

# 9. 추가 검토한 도서 API — 무엇을 더 붙일 수 있는가

현재 5종(Google Books · Open Library · Hardcover · Gutendex · 알라딘)에 더할 수 있는
후보를 조사한 결과입니다. **국내 도서 정확도를 올리는 것이 우선순위**입니다.

> 아래 사양은 각 서비스의 공식 문서를 확인한 내용입니다.
> 요금·쿼터는 바뀔 수 있으니 도입 전에 다시 확인하세요.

## 9-1. 우선순위 요약

| 순위 | API | 무료 | 왜 |
|---|---|---|---|
| 1 | **도서관 정보나루** | 무료 | 대출 데이터 기반 **추천**·인기도. 국가 운영 |
| 2 | **네이버 책** | 무료 (하루 25,000회) | 국내 커버리지 + **제목 전용 상세 검색** |
| 3 | **카카오 책** | 무료 | **절판·품절 상태**를 알려주는 유일한 소스 |
| 4 | ISBNdb | 유료 | 서지 정확도 최고. 국내서는 약함 |

## 9-2. 도서관 정보나루 (data4library.kr) — 가장 큰 기회

국립중앙도서관이 운영합니다. 전국 공공도서관 1,500곳 이상의 **실제 대출 데이터**입니다.

<https://www.data4library.kr> 회원가입 → 인증키 신청 → 발급

이 프로젝트에 의미 있는 엔드포인트:

| 엔드포인트 | 무엇을 주는가 |
|---|---|
| `loanItemSrch` | 인기대출도서. **연령·성별·지역·KDC분류·기간별** 필터 |
| `srchDtlList` | ISBN13 상세 — 도서명·KDC·저자·출판사·표지·책소개 + **대출 건수** |
| `usageAnalysisList` | 도서별 이용분석 — **함께 대출된 책** |
| `recommandList` | 마니아 / 다독자 추천도서 |
| `loanItemSrchByLib` | 도서관·지역별 인기대출 |
| `srchBooks` | 도서 검색 |

**왜 중요한가:** 지금 이 서비스에는 국내서의 "품질 신호" 가 없습니다.
Hardcover 평점은 영미권 도서만 있고, 알라딘 `customerReviewRank` 는 표본 수를 주지 않습니다.
정보나루의 대출 건수는 **실제로 얼마나 읽혔는지**를 나타내는 국내서 유일의 객관적 신호입니다.

`usageAnalysisList`(함께 대출된 책)는 협업 필터링 결과라 "이 책을 좋아하면 저 책도" 를
데이터로 답할 수 있게 합니다. LLM 의 추측이 아닌 근거입니다.

응답은 XML 입니다. 기존 어댑터들은 JSON 을 쓰므로 XML 파서가 필요합니다.

## 9-3. 네이버 책 검색

<https://developers.naver.com> 애플리케이션 등록 → 클라이언트 ID·시크릿

| 항목 | 값 |
|---|---|
| 검색 | `https://openapi.naver.com/v1/search/book.json` |
| 상세 | `https://openapi.naver.com/v1/search/book_adv.xml` (**XML만**) |
| 인증 | 헤더 `X-Naver-Client-Id`, `X-Naver-Client-Secret` |
| 쿼터 | **하루 25,000회** (검색 API 전체 합산) |

응답 필드: `title` · `author` · `publisher` · `pubdate` · `isbn`(10과 13 공백 구분) ·
`price` · `discount` · `image` · `description`

**`book_adv` 가 이 프로젝트에 정확히 맞습니다.** `d_titl`(제목), `d_isbn`(ISBN)
전용 파라미터로 조회합니다. 자유어 검색이 아니라 **제목 전용 필드**라
`lookup_books` 방식의 정확 조회에 적합합니다.

주의: `book_adv` 는 XML 만 반환합니다. 그리고 제목 응답에 `<b>` 태그가 섞여 옵니다
(검색어 강조). 제거해야 합니다.

## 9-4. 카카오 책 검색

<https://developers.kakao.com> 앱 생성 → REST API 키

| 항목 | 값 |
|---|---|
| 검색 | `https://dapi.kakao.com/v3/search/book` |
| 인증 | 헤더 `Authorization: KakaoAK ${REST_API_KEY}` |
| 필드 제한 | `target=title` \| `isbn` \| `publisher` \| `person` |
| 정렬 | `accuracy`(정확도) \| `latest`(발간일) |

응답 필드: `title` · `contents` · `url` · `isbn` · `datetime` · `authors[]` ·
`publisher` · `translators[]` · `price` · `sale_price` · `thumbnail` · **`status`**

**`status` 가 다른 어디에도 없는 값입니다.** `정상` / `품절` / `절판` 을 알려줍니다.
절판된 책을 추천하면 사용자가 구할 수 없으니 헛수고입니다. 지금은 그걸 걸러낼 방법이 없습니다.

`target=title` 로 제목만 검색할 수 있어 `lookup_books` 에 바로 쓸 수 있습니다.

> 문서에 "`status` 는 변동 가능성이 있으므로 문자열 처리 지양, 단순 노출 권장" 이라고
> 적혀 있습니다. 값으로 분기하지 말고 카드에 표시하는 용도로 쓰세요.

## 9-5. ISBNdb (유료)

<https://isbndb.com/isbn-database>

2001년부터 운영, 1억 권 이상. 책당 최대 19개 필드(ISBN10/13·제목·저자·출간일·출판사·
제본·페이지·정가·표지·언어·판차·판형·요약·주제·무게·크기). API 2.0 은 **한 호출로
최대 1,000권 벌크 조회**를 지원합니다. Basic 플랜에 7일 무료 시험이 있고,
학술·비영리는 Basic 의 50% 라고 안내합니다.

**이 프로젝트에는 우선순위가 낮습니다.** 서지 정확도는 최고지만 국내서 커버리지가 약하고,
지금 부족한 것은 서지 정확도가 아니라 **국내서 검색과 추천 근거**입니다.

## 9-6. 검토했지만 제외한 것

| API | 제외 이유 |
|---|---|
| Goodreads | 2020년에 신규 발급 중단. 사실상 폐지 |
| WorldCat (OCLC) | 기관 회원 필요 |
| 교보문고 · YES24 | 공개 API 없음 (제휴 필요) |
| The StoryGraph | 공개 API 없음 |
| BookBrainz | 개방형이지만 데이터가 희박 |

## 9-7. 붙이는 순서 제안

한 번에 다 붙이지 마세요. 하나씩 넣고 결과를 확인하는 편이 낫습니다.

1. **알라딘 키 설정** — 이미 갖고 있는 키입니다. 이것 없이는 나머지가 무의미합니다.
2. **Google Books 키 설정** — 익명 쿼터가 소진돼 실질적으로 죽어 있습니다.
3. **카카오 책 추가** — 어댑터가 가장 단순합니다(JSON, 헤더 1개). `status` 로 절판 표시.
4. **정보나루 추가** — XML 파서가 필요해 손이 더 갑니다. 대신 추천 품질이 가장 크게 오릅니다.
5. 네이버 책 — 커버리지 보강. 카카오와 겹치므로 나중에.

새 어댑터를 만들 때는 `tools/aladin.mjs` 를 그대로 본뜨세요.
키가 없으면 조용히 빈 배열을 돌려주고, 오류를 예외로 만들지 않는 규칙을 지켜야
한 소스가 죽어도 나머지로 답이 나갑니다.

---

# 10. 국립중앙도서관 소장자료 검색 API

<https://www.nl.go.kr/NL/contents/N31101030700.do>

국내 도서의 **서지 기준점**입니다. 납본 기관이라 국내에서 출간된 책이 사실상 전부 있습니다.

## 10-A. 알라딘과 어떻게 다른가

두 소스는 겹치지 않고 보완합니다. 그래서 한국어 질의에서는 **둘을 함께** 부릅니다.

| | 알라딘 | 국립중앙도서관 |
|---|---|---|
| 성격 | 서점 | 납본 도서관 |
| 강한 것 | 신간·베스트셀러·표지·구매 링크 | **절판·구간·학술서**·KDC 분류·ISBN |
| 약한 것 | 절판·오래된 책 | 표지 없음·평점 없음 |

## 10-B. 요청

| 항목 | 값 |
|---|---|
| 엔드포인트 | `https://www.nl.go.kr/NL/search/openApi/search.do` |
| 인증 | 쿼리 파라미터 `key` |
| 필수 | `key`, `pageNum`, `pageSize`, 그리고 검색어 또는 상세검색 조건 |
| 형식 | `apiType=xml` \| `json` |

주요 파라미터

| 이름 | 값 |
|---|---|
| `srchTarget` | `total` \| `title` \| `author` \| `publisher` \| `cheonggu` |
| `kwd` | 검색어 |
| `systemType` | `오프라인자료`(구 소장정보) \| `온라인자료`(구 디지털화자료) |
| `category` | `도서` \| `고문헌` 등 |
| `sort` / `order` | 정렬 필드 / `asc` \| `desc` |
| `govYn=Y` | 정부간행물 |

## 10-C. ★ 함정 세 가지 (실측)

### 1. 오류도 HTTP 200 으로 옵니다

알라딘과 똑같습니다. `if (!res.ok)` 만 보면 오류를 성공으로 착각합니다.

```bash
# 키 없이 호출 — 상태 코드는 200
$ curl -s '.../search.do?key=&apiType=json&kwd=%ED%86%A0%EC%A7%80&pageSize=3&pageNum=1'
{"errorCode":"010","errorMsg":"NO KEY VALUE:인증키값이 없습니다..."}

# 틀린 키 — 역시 200
{"errorCode":"011","errorMsg":"INVALID KEY:인증키값이 유효하지 않습니다."}
```

`tools/nlk.mjs` 는 본문의 `errorCode` 를 직접 확인하고 빈 배열을 돌려줍니다.

| 코드 | 뜻 |
|---|---|
| 010 | 인증키 누락 |
| 011 | 유효하지 않은 인증키 |
| 012 | 500건 초과 조회 불가 |
| 014 | 파라미터 값 오류 |
| 015 | 검색어 또는 상세검색 값 누락 |

### 2. 한글 파라미터를 반드시 인코딩해야 합니다

공식 문서에 명시돼 있습니다. `systemType=오프라인자료` 처럼 **값 자체가 한글**입니다.
`lib/http.mjs` 의 `buildUrl` 이 `encodeURIComponent` 를 적용하므로 그것만 쓰면 됩니다.

### 3. `kwd` 와 상세검색을 섞을 수 없습니다

문서: "Kwd 값과 상세검색 값은 혼용하여 사용이 불가능".
그래서 제목+저자 정확 조회는 `kwd` 없이 `detailSearch=true&f1=title&v1=…&f2=author&v2=…` 만 씁니다.

```
ISBN 조회: detailSearch=true&isbnOp=isbn&isbnCode=8984993727
```

## 10-D. 응답 정제

| 원본 필드 | 정제 |
|---|---|
| `title_info` | `"토지 / 박경리 지음"` → `"토지"` — 책임표시(` / ` 뒤)를 뗍니다 |
| | `"소년이 온다 = Human acts"` → `"소년이 온다"` — 병기 표제도 뗍니다 |
| `author_info` | `"요한 하리 지음 ; 김하현 옮김"` → `["요한 하리", "김하현"]` |
| `isbn` | `"8984993727"` → `"9788984993723"` (ISBN-10 → 13) |
| `kdc_name_1s` | KDC 대분류를 `categories` 로 — 장르 적합성 판정이 이 값을 봅니다 |
| `detail_link` | 상대 경로면 `https://www.nl.go.kr` 를 붙입니다 |

제목 정제를 빼먹으면 병합 키(`fuzzyKey`)가 어긋나 **같은 책이 카드 두 장**으로 나옵니다.
알라딘의 `(지은이)` 문제와 같은 원인입니다.

**표지 이미지가 없습니다.** 도서관 서지 데이터라 제공하지 않습니다. 그래서
`COVER_PRIORITY` 에서 맨 뒤에 두고, 표지는 알라딘·Google Books 쪽에서 받습니다.

## 10-E. 언어별 소스 라우팅

국중을 넣으면서 소스 구성을 언어로 갈랐습니다.

| 질의 | 호출하는 소스 |
|---|---|
| **한국어** | 알라딘 + 국립중앙도서관. 0권이면 Google Books 로 폴백 |
| 영어 | Google Books + Open Library + Hardcover |

Open Library 를 한국어 경로에서 뺀 이유는 실측입니다.

```
"한국 소설"        → 「한국 현대 소설 연구」, 「1960년대 한국 소설 연구」  (연구서)
"Korea"           → Pyongyang, Korea's Place in the Sun, Korea(여행서)
subject=thriller  → Treasure Island(1880), Dracula(1897)
```

Hardcover 도 국내서 커버리지가 ★☆☆☆☆ 라 지연만 늘립니다.

## 10-F. 회귀 테스트

```bash
cd backend && npm run test:features   # ■ 국중 절 + ■ 언어별 소스 라우팅
```

오류 응답이 예외가 되지 않는지, 저자·제목·ISBN 정제가 맞는지, 그리고
**한국어 경로에 Open Library 가 되살아나지 않는지**를 고정합니다.

## 10-G. 키를 SSM 에 넣기

`infra/oneshot.sh` 가 `~/keep/secrets.env` 의 `NLK_API_KEY` 를 자동으로
`/bookbot/prod/NLK_API_KEY` 에 넣습니다. 직접 넣으려면:

```bash
aws ssm put-parameter --region us-east-1 \
  --name "/bookbot/prod/NLK_API_KEY" \
  --value "발급받은키" --type SecureString --overwrite
```

헬스체크로 확인:

```bash
curl -s https://$(bash infra/print-domain.sh)/api/health | grep -o '"NLK_API_KEY":[a-z]*'
```

## 10-H. 연결 확인 — 4단계

**`npm run test:features` 로는 확인이 안 됩니다.** 그 테스트는 가짜 응답으로 파싱만
검증합니다. 그리고 이 API 는 **오류도 HTTP 200** 으로 오므로 "예외가 안 났다" 는
성공의 근거가 못 됩니다. 결과 건수를 봐야 합니다.

### 1단계 — 키가 실제로 되는가 (전용 스크립트)

```bash
cd backend
NLK_API_KEY=발급키 npm run check:nlk
```

다섯 가지를 순서대로 확인하고, **세 상태를 구분해서** 알려줍니다.

| 결과 | 뜻 |
|---|---|
| `errorCode 011` | 유효하지 않은 인증키 |
| `errorCode 010` | 키가 전달되지 않음 |
| 키는 통과, 결과 0건 | 파라미터 문제 |
| 책 목록이 출력됨 | 정상 |

검사 항목: ① 원본 응답의 `errorCode` ② 어댑터 정제(제목 책임표시·저자 역할 표기·상세 링크)
③ 제목+저자 상세검색 ④ ISBN 조회 ⑤ 한국어 질의에서 국중이 실제로 호출되고
Open Library 는 호출되지 않는지.

배포된 값으로 확인하려면 SSM 에서 꺼내 씁니다.

```bash
NLK_API_KEY=$(aws ssm get-parameter --region us-east-1 \
  --name /bookbot/prod/NLK_API_KEY --with-decryption \
  --query Parameter.Value --output text) node backend/scripts/nlk-check.mjs
```

> 키 값은 출력하지 않습니다. 앞 세 자와 길이만 보여줍니다.

### 2단계 — 스모크 테스트 (키가 있으면 자동)

```bash
NLK_API_KEY=발급키 ALADIN_TTB_KEY=ttb키 npm run smoke
```

```
PASS 국립중앙도서관 검색 (국내 서지) — 검색 3건 / 상세검색 3건 / 첫 결과 "토지" (문학)
```

키가 없으면 `SKIP` 으로 표시됩니다. **FAIL 이 아니라 SKIP 인 것에 주의하세요** —
키 미설정은 코드 버그가 아니지만, 그 상태로 배포하면 국내서 검색이 안 됩니다.

### 3단계 — 배포된 Lambda 가 키를 읽었는가

```bash
curl -s https://$(bash infra/print-domain.sh)/api/health \
  | python3 -m json.tool | grep -A8 '"secrets"'
```

`"NLK_API_KEY": true` 여야 합니다. `false` 면 SSM 파라미터 이름을 확인하세요.
`warnings` 배열에도 안내가 나옵니다.

### 4단계 — 실제 대화에서 불렸는가

한국어로 질문한 뒤 로그를 봅니다.

```bash
aws logs tail /aws/lambda/bookbot-api --region us-east-1 --since 10m \
  --filter-pattern 'nlk'
```

| 로그 | 뜻 |
|---|---|
| `"source":"nlk","count":N` (N>0) | 정상 동작 |
| `국중 오류 응답` + `errorCode` | 키 문제 |
| 아무 로그도 없음 | 한국어로 인식되지 않았거나 캐시 적중 |

**가장 확실한 증거는 화면입니다.** 국중에서 온 책은 카드에
**국립중앙도서관** 링크가 붙습니다. 그 링크가 보이면 서지가 실제로 조회된 것입니다.

> 배포 직후 첫 질문은 캐시가 없어 느립니다. 같은 질문을 두 번째로 하면
> 캐시에서 나오므로 로그에 소스 호출이 안 보입니다. 확인할 때는 매번 다른 질문을 쓰세요.
