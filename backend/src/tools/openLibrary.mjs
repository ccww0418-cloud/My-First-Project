/**
 * Open Library API (Internet Archive)
 * https://openlibrary.org/dev/docs/api/search
 *
 * 이 프로젝트에서의 역할: **주제(subject) 기반 탐색 + 무료 대출 가능 여부**
 *   - subject 태그가 매우 풍부해서 "이런 분위기/주제의 책" 탐색에 강함
 *   - /subjects/{subject}.json 엔드포인트로 주제별 인기 도서를 바로 받을 수 있음
 *   - ebook_access 필드로 Internet Archive에서 읽기/대출 가능한지 판별
 *   - API 키 불필요
 *
 * ⚠️ 함정:
 *   1) User-Agent를 안 보내거나 일반적인 값이면 403/429를 받습니다.
 *      → lib/http.mjs 에서 연락처가 담긴 UA를 항상 붙입니다.
 *   2) fields 파라미터를 지정하지 않으면 응답이 매우 커집니다(권당 수십 KB).
 *      → 필요한 필드만 명시해서 Lambda 메모리와 전송량을 아낍니다.
 */

import { fetchJson, buildUrl } from '../lib/http.mjs';
import { collectIsbn13 } from '../lib/isbn.mjs';
import { log } from '../lib/log.mjs';

const SEARCH = 'https://openlibrary.org/search.json';
const SUBJECTS = 'https://openlibrary.org/subjects';

const FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'first_publish_year',
  'publisher',
  'cover_i',
  'isbn',
  'subject',
  'ratings_average',
  'ratings_count',
  'ebook_access',
  'ia',
  'language',
  'number_of_pages_median',
  'first_sentence',
].join(',');

/**
 * 자유 텍스트 검색.
 * @returns {Promise<import('./merge.mjs').NormalizedBook[]>}
 */
/**
 * @param {object} p
 * @param {number} [p.yearFrom]  이 연도 이후 초판만 (신간 요청용)
 * @param {number} [p.yearTo]
 */
export async function searchOpenLibrary({ query, limit = 8, language, yearFrom, yearTo } = {}) {
  if (!query) return [];

  // 연도 범위는 Solr 문법으로 q 에 직접 넣습니다.
  //
  // ⚠️ sort=new 는 쓰지 않습니다. 확인해보니 메타데이터 오류가 심해서
  //    first_publish_year 가 9999, 2312, 2098 인 항목들이 최상단에 옵니다.
  //    반면 first_publish_year:[2024 TO 2026] 범위 필터는 정확하게 동작합니다.
  let q = query;
  if (yearFrom || yearTo) {
    const from = yearFrom || 1000;
    const to = yearTo || new Date().getFullYear() + 1;
    q = `${query} first_publish_year:[${from} TO ${to}]`;
  }

  const url = buildUrl(SEARCH, {
    q,
    fields: FIELDS,
    limit: Math.min(Math.max(limit, 1), 20),
    lang: language, // 결과 메타데이터 우선 언어
  });

  try {
    // retries 미지정 — http.mjs 의 EXTERNAL_API_RETRIES(기본 1)를 따릅니다.
    // googleBooks.mjs 와 같은 이유입니다: retries: 2 로 덮어쓰면 최악 16초가 되어
    // 도구 예산을 한 소스가 독식합니다.
    const data = await fetchJson(url, { label: 'openLibrary.search' });
    return (data?.docs ?? []).map(normalizeSearchDoc).filter((b) => b.title);
  } catch (err) {
    log.warn('openLibrary 검색 실패', { query, status: err.status, body: err.bodySnippet });
    return [];
  }
}

/**
 * 무료 전문 검색 — Gutendex 폴백용.
 *
 * 왜 필요한가:
 *   gutendex.com은 무료 공개 인스턴스라 자주 죽습니다(실제로 이 프로젝트 개발 중에도 503/무응답).
 *   Gutendex가 죽으면 "무료로 읽을 수 있는 책" 기능이 통째로 사라지는데,
 *   Open Library의 has_fulltext + ebook_access=public 조합이 거의 같은 역할을 합니다.
 *   Internet Archive에서 전문을 읽을 수 있는 책만 걸러줍니다.
 *
 *   차이점: Gutendex는 EPUB/TXT 파일 URL을 직접 주고, 이쪽은 archive.org 뷰어 링크를 줍니다.
 *   기능적으로는 "지금 바로 무료로 읽을 수 있다"가 동일하게 성립합니다.
 */
export async function searchFreeFullText({ query, subject, limit = 6 } = {}) {
  if (!query && !subject) return [];

  const url = buildUrl(SEARCH, {
    q: query || undefined,
    subject: subject ? String(subject).replace(/_/g, ' ') : undefined,
    has_fulltext: 'true',
    // 대출(borrowable)이 아니라 즉시 열람 가능한 것만
    ebook_access: 'public',
    fields: FIELDS,
    limit: Math.min(Math.max(limit, 1), 20),
    sort: 'readinglog', // 실제로 많이 읽힌 순 → 품질 필터 역할
  });

  try {
    const data = await fetchJson(url, { label: 'openLibrary.freeFullText', retries: 1 });
    return (data?.docs ?? [])
      .map(normalizeSearchDoc)
      .filter((b) => b.title && b.freeEbook) // 무료 전문이 확인된 것만
      .slice(0, limit);
  } catch (err) {
    log.warn('openLibrary 무료 전문 검색 실패', { query, subject, status: err.status });
    return [];
  }
}

/**
 * 주제별 인기 도서. "잔잔한 위로가 되는 소설" 같은 무드성 요청에서
 * subject를 골라 호출하면 Google Books 키워드 검색보다 결과 품질이 좋습니다.
 *
 * @param {string} subject  예: 'science_fiction', 'love', 'detective_and_mystery_stories'
 */
export async function browseSubject({ subject, limit = 10, ebooksOnly = false } = {}) {
  if (!subject) return [];
  // Open Library subject 슬러그: 소문자 + 공백을 언더스코어로
  const slug = String(subject).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!slug) return [];

  const url = buildUrl(`${SUBJECTS}/${slug}.json`, {
    limit: Math.min(Math.max(limit, 1), 20),
    ebooks: ebooksOnly ? 'true' : undefined,
  });

  try {
    const data = await fetchJson(url, { label: 'openLibrary.subject', retries: 1 });
    return (data?.works ?? []).map((w) => normalizeSubjectWork(w, data?.name || subject)).filter((b) => b.title);
  } catch (err) {
    log.warn('openLibrary 주제 조회 실패', { subject: slug, status: err.status });
    return [];
  }
}

function coverFrom(coverId, isbn13) {
  if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
  if (isbn13?.length) return `https://covers.openlibrary.org/b/isbn/${isbn13[0]}-L.jpg`;
  return null;
}

function normalizeSearchDoc(d) {
  const isbn13 = collectIsbn13(d.isbn ?? []);
  const workKey = d.key ?? ''; // '/works/OL45804W'
  const borrowable = d.ebook_access === 'borrowable' || d.ebook_access === 'public';

  return {
    id: `ol:${workKey.replace(/^\/works\//, '')}`,
    title: d.title ?? '',
    subtitle: d.subtitle ?? '',
    authors: d.author_name ?? [],
    year: d.first_publish_year ?? null,
    publisher: Array.isArray(d.publisher) ? d.publisher[0] ?? '' : d.publisher ?? '',
    isbn13,
    pageCount: d.number_of_pages_median ?? null,
    categories: (d.subject ?? []).slice(0, 12),
    language: Array.isArray(d.language) ? d.language[0] ?? '' : '',
    description: typeof d.first_sentence === 'string'
      ? d.first_sentence
      : Array.isArray(d.first_sentence) ? d.first_sentence[0] ?? '' : '',
    coverUrl: coverFrom(d.cover_i, isbn13),
    rating: d.ratings_average
      ? { value: Math.round(d.ratings_average * 10) / 10, count: d.ratings_count ?? 0, source: 'Open Library' }
      : null,
    moods: [],
    genres: [],
    contentWarnings: [],
    series: null,
    freeEbook: d.ebook_access === 'public' && d.ia?.length
      ? { source: 'Internet Archive', links: { read: `https://archive.org/details/${d.ia[0]}` } }
      : null,
    links: {
      openLibrary: workKey ? `https://openlibrary.org${workKey}` : null,
      borrow: borrowable && d.ia?.length ? `https://archive.org/details/${d.ia[0]}` : null,
    },
    sources: ['openLibrary'],
  };
}

function normalizeSubjectWork(w, subjectName) {
  // 예전에는 collectIsbn13([]) 로 항상 빈 배열을 만들었습니다(무의미한 호출).
  // subjects API 는 availability.isbn 에 대출 가능 판본의 ISBN을 주는 경우가 있어
  // 그 값을 쓰면 다른 소스와 ISBN으로 정확히 병합됩니다.
  const isbn13 = collectIsbn13([w.availability?.isbn].filter(Boolean));
  return {
    id: `ol:${String(w.key ?? '').replace(/^\/works\//, '')}`,
    title: w.title ?? '',
    subtitle: '',
    authors: (w.authors ?? []).map((a) => a.name).filter(Boolean),
    year: w.first_publish_year ?? null,
    publisher: '',
    isbn13,
    pageCount: null,
    categories: [subjectName, ...(w.subject ?? []).slice(0, 8)].filter(Boolean),
    language: '',
    description: '',
    coverUrl: coverFrom(w.cover_id, isbn13),
    rating: null,
    moods: [],
    genres: [],
    contentWarnings: [],
    series: null,
    freeEbook: w.ia && w.availability?.status === 'open'
      ? { source: 'Internet Archive', links: { read: `https://archive.org/details/${w.ia}` } }
      : null,
    links: {
      openLibrary: w.key ? `https://openlibrary.org${w.key}` : null,
      borrow: w.ia ? `https://archive.org/details/${w.ia}` : null,
    },
    sources: ['openLibrary'],
  };
}
