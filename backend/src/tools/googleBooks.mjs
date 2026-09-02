/**
 * Google Books API
 * https://developers.google.com/books/docs/v1/using
 *
 * 이 프로젝트에서의 역할: **1차 검색 엔진 + 서지 메타데이터 기준점**
 *   - 4개 소스 중 커버리지가 가장 넓고 한국어 도서도 잘 잡힘
 *   - 표지 이미지, 카테고리, 페이지 수, 미리보기 링크 제공
 *   - 필드 검색 문법 지원: intitle:, inauthor:, subject:, isbn:
 *
 * ⚠️ Lambda에서 반드시 알아야 할 함정:
 *   `country` 파라미터를 안 넣으면 Google이 호출자 위치를 판단할 수 없다며
 *   403 { reason: "unknownLocation" } 을 반환합니다.
 *   로컬 PC에서는 잘 되다가 Lambda에 올리면 갑자기 실패하는 대표적 원인입니다.
 *   그래서 country 를 항상 명시합니다.
 *
 *   ⚠️ country 는 단순한 필수 파라미터가 아니라 **시장(market) 선택**입니다.
 *   판매·미리보기 가용성과 결과 구성이 이 값에 따라 달라집니다.
 *   예전에는 'KR' 을 상수로 박아둬서, 영어 UI로 접속한 유럽 사용자에게도
 *   한국 시장 기준 결과가 갔습니다. 그래서 환경 변수로 뺐습니다.
 *     GOOGLE_BOOKS_COUNTRY=US   (미설정 시 KR)
 *
 * 쿼터: API 키 기준 기본 1,000회/일. 캐시가 필수인 이유.
 */

import { fetchJson, buildUrl } from '../lib/http.mjs';
import { collectIsbn13 } from '../lib/isbn.mjs';
import { log } from '../lib/log.mjs';

/** ISO 3166-1 alpha-2. 두 글자가 아니면 무시하고 기본값을 씁니다. */
const COUNTRY = /^[A-Za-z]{2}$/.test(process.env.GOOGLE_BOOKS_COUNTRY || '')
  ? process.env.GOOGLE_BOOKS_COUNTRY.toUpperCase()
  : 'KR';

const ENDPOINT = 'https://www.googleapis.com/books/v1/volumes';

/**
 * 자연어 조건을 Google Books 쿼리 문법으로 조립.
 * 예) { text:'우주', author:'김초엽', subject:'science fiction' }
 *     -> '우주 inauthor:"김초엽" subject:"science fiction"'
 */
export function buildQuery({ text = '', title, author, subject, isbn } = {}) {
  const parts = [];
  if (isbn) return `isbn:${String(isbn).replace(/[^0-9Xx]/g, '')}`;
  if (text) parts.push(text.trim());
  if (title) parts.push(`intitle:"${title.replace(/"/g, '')}"`);
  if (author) parts.push(`inauthor:"${author.replace(/"/g, '')}"`);
  if (subject) parts.push(`subject:"${subject.replace(/"/g, '')}"`);
  return parts.join(' ').trim();
}

/**
 * @param {object} params
 * @param {string} params.query          Google Books 쿼리 문자열
 * @param {string} [params.apiKey]
 * @param {number} [params.limit=8]
 * @param {string} [params.language]     ISO 639-1 (ko, en, ja...)
 * @returns {Promise<import('./merge.mjs').NormalizedBook[]>}
 */
export async function searchGoogleBooks({ query, apiKey, limit = 8, language, orderBy = 'relevance' } = {}) {
  if (!query) return [];

  const url = buildUrl(ENDPOINT, {
    q: query,
    key: apiKey || undefined,
    maxResults: Math.min(Math.max(limit, 1), 40),
    printType: 'books',
    // 'newest' 로 바꾸면 출간일 역순. 신간 요청에 필수입니다.
    // 기본 'relevance' 는 이미 널리 읽힌 책(=오래된 책)을 위로 올립니다.
    orderBy: orderBy === 'newest' ? 'newest' : 'relevance',
    langRestrict: language,
    // Lambda에서 필수 (위 주석 참고). 값은 시장을 결정하므로 환경 변수로 조정합니다.
    country: COUNTRY,
  });

  let data;
  try {
    // retries 를 지정하지 않습니다 — http.mjs 의 DEFAULT_RETRIES(env
    // EXTERNAL_API_RETRIES, 기본 1)를 그대로 씁니다.
    //
    // 전에는 여기서 retries: 2 로 덮어썼습니다. 그런데 http.mjs 는 "재시도를
    // 1회로 줄여 최악 10.3초" 라는 이유를 주석에 적어두고 있었고, 이 한 줄이
    // 그 의도를 무효로 만들었습니다. 실제로는 시도 3회 × 5초 + 백오프 ≈ 16초라
    // 느린 날 이 소스 하나가 18초 예산을 거의 혼자 썼습니다.
    // 소스가 병렬이고 allSettled 라 하나 실패해도 나머지로 답합니다.
    // 재시도를 늘려야 하면 EXTERNAL_API_RETRIES 로 전 소스에 일괄 적용하세요.
    data = await fetchJson(url, { label: 'googleBooks' });
  } catch (err) {
    // 403 unknownLocation 이나 429 쿼터 초과를 알아보기 쉽게 로그에 남긴다
    log.warn('googleBooks 검색 실패', {
      query,
      status: err.status,
      hint: err.status === 403
        ? 'country 파라미터 또는 API 키 제한 확인. Books API가 활성화되었는지도 확인하세요.'
        : err.status === 429
          ? '일일 쿼터(1000회) 초과 가능성. Cloud Console에서 쿼터 확인.'
          : undefined,
      body: err.bodySnippet,
    });
    return [];
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map(normalize).filter((b) => b.title);
}

function normalize(item) {
  const v = item?.volumeInfo ?? {};
  const access = item?.accessInfo ?? {};
  const isbn13 = collectIsbn13(v.industryIdentifiers ?? []);
  const year = Number(String(v.publishedDate ?? '').slice(0, 4)) || null;

  // Google 표지는 http로 오는 경우가 있어 https로 강제 (혼합 콘텐츠 차단 방지)
  const cover = (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '').replace(/^http:/, 'https:');

  return {
    id: `gb:${item.id}`,
    title: v.title ?? '',
    subtitle: v.subtitle ?? '',
    authors: v.authors ?? [],
    year,
    publisher: v.publisher ?? '',
    isbn13,
    pageCount: v.pageCount ?? null,
    categories: v.categories ?? [],
    language: v.language ?? '',
    description: trim(v.description, 900),
    coverUrl: cover || null,
    rating: v.averageRating ? { value: v.averageRating, count: v.ratingsCount ?? 0, source: 'Google Books' } : null,
    moods: [],
    genres: [],
    contentWarnings: [],
    series: null,
    freeEbook: access.epub?.isAvailable && access.accessViewStatus === 'FULL_PUBLIC_DOMAIN'
      ? { source: 'Google Books', links: { reader: access.webReaderLink ?? null } }
      : null,
    links: {
      googleBooks: v.infoLink ?? null,
      preview: v.previewLink ?? null,
    },
    sources: ['googleBooks'],
  };
}

function trim(s, n) {
  if (!s) return '';
  const t = String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
