/**
 * Gutendex — Project Gutenberg 메타데이터 JSON API
 * https://gutendex.com/
 *
 * 이 프로젝트에서의 역할: **"지금 바로 무료로 읽을 수 있는 책"**
 *   다른 3개 소스는 "이런 책이 있다"까지만 알려줍니다.
 *   Gutendex는 퍼블릭 도메인 책의 **실제 원문 다운로드 URL**(txt/epub/html)을 줍니다.
 *   → 챗봇이 "이 책은 저작권이 풀려서 지금 바로 읽으실 수 있어요 [EPUB 다운로드]"
 *     라고 말할 수 있게 되는, 체감 만족도가 가장 높은 기능입니다.
 *
 * API 키 불필요. 인증 없음. 페이지당 최대 32건.
 *
 * 검증된 파라미터 (공식 문서 기준):
 *   search, languages, topic, sort(popular|ascending|descending),
 *   copyright(true|false|null), ids, author_year_start, author_year_end, mime_type
 *
 * 참고: 응답의 `formats`는 { "MIME 타입": "URL" } 맵입니다.
 *
 * ⚠️⚠️ 가장 중요한 운영 주의사항 — gutendex.com은 자주 죽습니다 ⚠️⚠️
 *   공식 문서에도 "장기적으로 쓸 거면 직접 서버를 돌리라"고 적혀 있습니다.
 *   이 프로젝트를 만들면서 실제로 확인한 문제들:
 *     1) /books 로 요청하면 /books/ 로 301 리다이렉트합니다.
 *        리다이렉트 홉이 늘어나면서 타임아웃 확률이 올라갑니다 → 항상 `/books/` 로 호출.
 *     2) 트래픽이 몰리면 503을 내거나 아예 응답이 없습니다(무한 대기).
 *        → 타임아웃을 짧게(4초) 잡고 재시도를 1회로 제한. Lambda를 붙잡아두면 안 됩니다.
 *     3) 시점에 따라 Cloudflare 챌린지로 403이 나올 수도 있습니다.
 *
 *   그래서 3중 방어를 넣었습니다:
 *     (a) GUTENDEX_BASE_URLS 환경 변수로 미러 목록을 넣으면 순차 페일오버
 *     (b) 짧은 타임아웃 + 재시도 최소화
 *     (c) 전부 실패하면 tools/index.mjs 가 Open Library(Internet Archive) 무료 전문
 *         검색으로 자동 대체 → "무료로 읽을 수 있는 책" 기능이 죽지 않습니다
 *
 *   2주 내내 안정적으로 돌리고 싶다면 Gutendex를 직접 호스팅하는 것도 방법입니다.
 *   (docs/03-external-apis.md 의 "Gutendex 자체 호스팅" 참고)
 */

import { fetchJson, buildUrl } from '../lib/http.mjs';
import { log } from '../lib/log.mjs';

/**
 * 기본은 공식 인스턴스 하나. 미러를 알고 있으면 환경 변수로 추가하세요.
 *   GUTENDEX_BASE_URLS=https://gutendex.com,https://my-gutendex.example.com
 * 뒤에 오는 항목이 폴백입니다.
 */
const BASE_URLS = (process.env.GUTENDEX_BASE_URLS || 'https://gutendex.com')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// gutendex.com이 느릴 때 Lambda 전체가 느려지는 걸 막기 위해 별도 타임아웃
const GUTENDEX_TIMEOUT_MS = Number(process.env.GUTENDEX_TIMEOUT_MS || 4000);

/**
 * @param {object} params
 * @param {string} [params.query]      제목/저자 검색어 (공백 구분)
 * @param {string} [params.topic]      주제/서가 키프레이즈 (예: 'detective', 'philosophy')
 * @param {string} [params.languages]  쉼표 구분 2자 코드 (예: 'en' 또는 'en,fr')
 * @param {number} [params.limit=6]
 * @returns {Promise<import('./merge.mjs').NormalizedBook[]>}
 */
export async function searchGutendex({ query, topic, languages, limit = 6 } = {}) {
  if (!query && !topic) return [];

  const params = {
    search: query,
    topic,
    languages,
    sort: 'popular', // 다운로드 수 기준 인기순 = 사실상 품질 필터
    copyright: 'false', // 미국 기준 퍼블릭 도메인만 (= 확실히 무료)
  };

  for (const base of BASE_URLS) {
    // 반드시 trailing slash. `/books` 는 301 리다이렉트를 유발합니다.
    const url = buildUrl(`${base}/books/`, params);
    try {
      const data = await fetchJson(url, {
        label: `gutendex(${new URL(base).host})`,
        retries: 1,
        timeoutMs: GUTENDEX_TIMEOUT_MS,
      });
      const books = (data?.results ?? []).slice(0, limit).map(normalize).filter((b) => b.title);
      if (books.length) return books;
      log.debug('gutendex 결과 0건 — 다음 미러 시도', { base });
    } catch (err) {
      log.warn('gutendex 호출 실패 — 다음 미러 시도', {
        base,
        status: err.status,
        reason: err.name === 'AbortError' ? 'timeout' : err.message,
      });
    }
  }

  log.warn('gutendex 전체 실패 — Open Library 무료 전문 검색으로 대체됩니다', { query, topic });
  return [];
}

/** formats 맵에서 우리가 쓸 링크만 골라낸다 */
function pickFormats(formats = {}) {
  const find = (predicate) => {
    for (const [mime, url] of Object.entries(formats)) {
      if (predicate(mime) && !String(url).endsWith('.zip')) return url;
    }
    return null;
  };
  return {
    epub: find((m) => m.startsWith('application/epub+zip')),
    // 'text/plain; charset=utf-8' 같은 형태여서 startsWith로 매칭
    txt: find((m) => m.startsWith('text/plain')),
    html: find((m) => m.startsWith('text/html')),
    kindle: find((m) => m.startsWith('application/x-mobipocket-ebook')),
    cover: find((m) => m.startsWith('image/jpeg')),
  };
}

function normalize(b) {
  const f = pickFormats(b.formats);
  const authors = (b.authors ?? []).map((a) => a.name).filter(Boolean);
  // Gutenberg 저자명은 "Austen, Jane" 형식 → "Jane Austen" 으로 정리
  const prettyAuthors = authors.map((n) => {
    const m = /^([^,]+),\s*(.+)$/.exec(n);
    return m ? `${m[2].trim()} ${m[1].trim()}` : n;
  });

  const readUrl = f.html || f.txt || f.epub;

  return {
    id: `gutenberg:${b.id}`,
    title: b.title ?? '',
    subtitle: '',
    authors: prettyAuthors,
    // Gutenberg는 출판연도가 없어서 저자 사망연도로 시대만 추정 (표시용)
    year: null,
    publisher: 'Project Gutenberg',
    isbn13: [], // Gutenberg 책은 ISBN이 없음 → merge.mjs의 fuzzyKey로 병합
    pageCount: null,
    categories: [...(b.bookshelves ?? []), ...(b.subjects ?? [])].slice(0, 10),
    language: (b.languages ?? [])[0] ?? '',
    description: (b.summaries ?? [])[0] ?? '',
    coverUrl: f.cover ?? null,
    rating: null,
    moods: [],
    genres: [],
    contentWarnings: [],
    series: null,
    // 이게 Gutendex를 쓰는 유일한 이유
    freeEbook: {
      source: 'Project Gutenberg',
      downloadCount: b.download_count ?? null,
      links: {
        read: readUrl,
        epub: f.epub,
        txt: f.txt,
        html: f.html,
        kindle: f.kindle,
      },
    },
    links: {
      gutenberg: `https://www.gutenberg.org/ebooks/${b.id}`,
      preview: readUrl,
    },
    sources: ['gutendex'],
  };
}
