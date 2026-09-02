/**
 * Hardcover GraphQL API
 * https://docs.hardcover.app/api/guides/searching/
 *
 * 이 프로젝트에서의 역할: **추천 근거 데이터** — 이게 챗봇의 품질을 결정합니다.
 *
 *   다른 3개 소스는 "무슨 책인가"(서지 정보)를 줍니다.
 *   Hardcover만 "어떤 느낌의 책인가"를 줍니다:
 *     moods            잔잔함/긴장감/유쾌함 같은 정서 태그
 *     genres           독자가 붙인 실제 장르 (출판사 분류보다 정확)
 *     content_warnings 폭력/자살 언급 등 사전 경고
 *     rating           커뮤니티 평점 + 평가 수
 *     featured_series  시리즈 정보 (다음 권 추천에 사용)
 *     pages, has_audiobook, has_ebook
 *
 *   → "잠들기 전에 읽을 편안한 책" 같은 요청에 진짜로 답할 수 있는 유일한 소스.
 *
 * 기술 사양 (문서 확인 기준):
 *   - 엔드포인트: POST https://api.hardcover.app/v1/graphql
 *   - 인증: Authorization: Bearer <token>  (hardcover.app/account/api 에서 발급)
 *   - 레이트리밋: 60 요청/분  → 캐시 필수
 *   - 최대 쿼리 깊이: 3       → search { results } 는 깊이 2로 안전
 *   - 검색 백엔드는 Typesense. `results`는 JSON 스칼라로 내려옵니다.
 *
 * ⚠️ 함정: 발급된 토큰 문자열에 이미 "Bearer "가 포함되어 있는 경우가 있습니다.
 *   그대로 붙이면 "Bearer Bearer ey..." 가 되어 401이 납니다. normalizeToken()으로 처리합니다.
 */

import { fetchJson } from '../lib/http.mjs';
import { collectIsbn13 } from '../lib/isbn.mjs';
import { log } from '../lib/log.mjs';

const ENDPOINT = 'https://api.hardcover.app/v1/graphql';

// sort 를 넘기면 Typesense 정렬을 바꿉니다.
// 기본 정렬은 _text_match:desc,users_count:desc 라서 **이미 유명한 책**(=오래된 책)이
// 위로 옵니다. 신간을 원하면 release_date_i:desc 를 넘겨야 합니다.
const SEARCH_QUERY = `
query BookBotSearch($q: String!, $type: String!, $perPage: Int!, $sort: String) {
  search(query: $q, query_type: $type, per_page: $perPage, page: 1, sort: $sort) {
    ids
    results
  }
}`.trim();

/** "Bearer xxx" / "xxx" 모두 받아서 항상 "Bearer xxx" 로 만든다 */
function normalizeToken(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  return /^bearer\s/i.test(t) ? `Bearer ${t.replace(/^bearer\s+/i, '')}` : `Bearer ${t}`;
}

/**
 * @param {object} params
 * @param {string} params.query
 * @param {string} params.token           Hardcover API 토큰
 * @param {'Book'|'Author'|'Series'|'List'} [params.queryType='Book']
 * @param {number} [params.limit=8]
 * @returns {Promise<import('./merge.mjs').NormalizedBook[]>}
 */
export async function searchHardcover({ query, token, queryType = 'Book', limit = 8, sort } = {}) {
  if (!query) return [];
  const auth = normalizeToken(token);
  if (!auth) {
    log.warn('hardcover 토큰 없음 — 이 소스를 건너뜁니다', {
      hint: 'SSM /bookbot/prod/HARDCOVER_TOKEN 확인',
    });
    return [];
  }

  let data;
  try {
    data = await fetchJson(ENDPOINT, {
      method: 'POST',
      label: 'hardcover',
      headers: { Authorization: auth },
      body: {
        query: SEARCH_QUERY,
        variables: {
          q: query,
          type: queryType,
          perPage: Math.min(Math.max(limit, 1), 25),
          sort: sort || null,
        },
      },
      retries: 1, // 60req/min 제한이 있으므로 재시도는 최소화
    });
  } catch (err) {
    log.warn('hardcover 검색 실패', {
      query,
      status: err.status,
      hint: err.status === 401 ? '토큰이 만료되었거나 형식이 잘못되었습니다.'
        : err.status === 429 ? '분당 60회 제한 초과.' : undefined,
      body: err.bodySnippet,
    });
    return [];
  }

  // GraphQL은 HTTP 200이면서 errors를 담아 보낼 수 있음
  if (data?.errors?.length) {
    log.warn('hardcover GraphQL 오류', { errors: data.errors.map((e) => e.message).slice(0, 3) });
    return [];
  }

  const hits = extractHits(data?.data?.search?.results);
  if (queryType !== 'Book') {
    // Author/Series 검색은 원본 문서를 그대로 반환 (에이전트가 후속 Book 검색에 사용)
    return hits.map((h) => ({ raw: h }));
  }
  return hits.slice(0, limit).map(normalize).filter((b) => b.title);
}

/**
 * Typesense 응답 모양이 버전에 따라 조금씩 다를 수 있어 방어적으로 파싱.
 *   기대 형태: { found, hits: [{ document: {...} }] }
 */
function extractHits(results) {
  if (!results) return [];
  const r = typeof results === 'string' ? safeParse(results) : results;
  if (!r) return [];
  if (Array.isArray(r.hits)) return r.hits.map((h) => h?.document ?? h).filter(Boolean);
  if (Array.isArray(r)) return r.map((h) => h?.document ?? h).filter(Boolean);
  return [];
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalize(d) {
  const isbn13 = collectIsbn13(d.isbns ?? []);
  const rating = Number(d.rating);

  return {
    id: `hc:${d.id ?? d.slug ?? ''}`,
    title: d.title ?? '',
    subtitle: d.subtitle ?? '',
    authors: d.author_names ?? [],
    year: Number(String(d.release_year ?? '').slice(0, 4)) || null,
    publisher: '',
    isbn13,
    pageCount: d.pages ?? null,
    categories: (d.genres ?? []).slice(0, 8),
    language: '',
    description: trim(d.description, 700),
    coverUrl: d.image?.url ?? null,
    rating: Number.isFinite(rating) && rating > 0
      ? { value: Math.round(rating * 10) / 10, count: d.ratings_count ?? 0, source: 'Hardcover' }
      : null,

    // ↓↓↓ Hardcover를 쓰는 진짜 이유 ↓↓↓
    moods: (d.moods ?? []).slice(0, 6),
    genres: (d.genres ?? []).slice(0, 6),
    contentWarnings: (d.content_warnings ?? []).slice(0, 6),
    series: d.featured_series?.series_name || (d.series_names ?? [])[0] || null,
    seriesPosition: d.featured_series_position ?? null,
    hasAudiobook: Boolean(d.has_audiobook),
    hasEbook: Boolean(d.has_ebook),
    readersCount: d.users_read_count ?? null,

    freeEbook: null,
    links: {
      hardcover: d.slug ? `https://hardcover.app/books/${d.slug}` : null,
    },
    sources: ['hardcover'],
  };
}

function trim(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
