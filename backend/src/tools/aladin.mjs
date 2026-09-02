/**
 * 알라딘 상품 검색 API (TTB)
 * https://blog.naver.com/aladinbooks (Open API 매뉴얼)
 *
 * 이 프로젝트에서의 역할: **국내 도서 담당**
 *
 *   왜 필요한가:
 *     기존 4개 소스(Google Books, Open Library, Hardcover, Gutenberg)는 전부
 *     영미권입니다. 실측해보니 "kisaeng", "기생" 같은 한국 주제어는 0건이었습니다.
 *     한국어 화면을 제공하면서 한국 책을 못 찾는 모순을 없애기 위해 추가했습니다.
 *
 *   이 소스만 줄 수 있는 것:
 *     · 국내 출간 도서의 정확한 제목·저자·출판사 (한글 그대로)
 *     · 국내 기준 카테고리 ("국내도서>소설/시/희곡>한국소설")
 *     · 표지 이미지
 *     · 독자 평점 (customerReviewRank, 0~10)
 *
 * 쿼터: TTB 키 기준 하루 5,000회. 캐시가 있어 실사용에서는 여유롭습니다.
 *
 * ⚠️ 오류를 HTTP 상태로 알려주지 않습니다.
 *    키가 틀려도 200 OK 에 { errorCode, errorMessage } 를 담아 보냅니다.
 *    그래서 본문을 직접 확인해야 합니다. (실측 확인: errorCode 4)
 */

import { fetchJson, buildUrl } from '../lib/http.mjs';
import { toIsbn13 } from '../lib/isbn.mjs';
import { log } from '../lib/log.mjs';

const SEARCH_URL = 'https://www.aladin.co.kr/ttb/api/ItemSearch.aspx';

/** 한글(음절·자모)이 하나라도 있는지 */
export function hasHangul(s) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(String(s ?? ''));
}

/**
 * 국내 도서 검색.
 *
 * @param {object} p
 * @param {string} p.query        검색어 (한글 그대로 넣습니다)
 * @param {string} p.key          TTB 키
 * @param {number} [p.limit=8]
 * @param {'Keyword'|'Title'|'Author'|'Publisher'} [p.queryType='Keyword']
 * @param {boolean} [p.recent=false]  신간 우선 정렬
 * @returns {Promise<import('./merge.mjs').NormalizedBook[]>}
 */
export async function searchAladin({ query, key, limit = 8, queryType = 'Keyword', recent = false }) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  if (!key) {
    // 키가 없으면 조용히 건너뜁니다. 나머지 소스로 답이 나가야 하므로 예외를 던지지 않습니다.
    log.debug('알라딘 건너뜀 — ALADIN_TTB_KEY 없음');
    return [];
  }

  const url = buildUrl(SEARCH_URL, {
    ttbkey: key,
    Query: q,
    QueryType: queryType,
    MaxResults: Math.min(Math.max(limit, 1), 50),
    start: 1,
    SearchTarget: 'Book',
    // PublishTime = 출간일 역순. 신간 요청일 때만 씁니다.
    Sort: recent ? 'PublishTime' : 'Accuracy',
    Cover: 'Big',
    output: 'js',
    Version: '20131101',
  });

  let data;
  try {
    data = await fetchJson(url, { label: 'aladin' });
  } catch (err) {
    log.warn('알라딘 검색 실패', { query: q, status: err.status, body: err.bodySnippet });
    return [];
  }

  // ★ 200 OK 에 오류가 담겨 오는 API 입니다. 반드시 본문을 확인합니다.
  if (data?.errorCode) {
    log.warn('알라딘이 오류를 반환', {
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
      hint:
        data.errorCode === 4 || data.errorCode === 1
          ? 'TTB 키가 잘못되었거나 사용이 정지된 계정입니다. SSM /bookbot/prod/ALADIN_TTB_KEY 확인.'
          : undefined,
    });
    return [];
  }

  const items = Array.isArray(data?.item) ? data.item : [];
  return items.map(normalize).filter((b) => b.title);
}

/**
 * 알라딘 author 필드를 저자 배열로 정리.
 *
 * 알라딘은 역할을 괄호로 붙여 한 문자열에 몰아넣습니다.
 *   "한강 (지은이)"
 *   "요한 하리 (지은이), 김하현 (옮긴이)"
 *   "김초엽 (지은이), 오승원 (그림)"
 *
 * 그대로 쓰면 저자명이 "한강 (지은이)" 가 되어 다른 소스와 병합되지 않습니다.
 * (merge.mjs 의 fuzzyKey 가 제목+첫 저자로 매칭하기 때문)
 *
 * 그래서 역할을 떼고, **지은이·글·저 를 앞으로** 보냅니다.
 * 옮긴이·그림·엮은이는 뒤로 밀되 버리지는 않습니다.
 */
export function parseAuthors(raw) {
  const parts = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const primary = [];
  const secondary = [];

  for (const part of parts) {
    const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(part);
    const name = (m ? m[1] : part).trim();
    const role = m ? m[2].trim() : '';
    if (!name) continue;
    // 원저자 계열을 우선합니다
    if (!role || /지은이|저자|^저$|글|원작/.test(role)) primary.push(name);
    else secondary.push(name);
  }

  return [...primary, ...secondary].slice(0, 5);
}

/**
 * "국내도서>소설/시/희곡>한국소설>2000년대 한국소설"
 *   → ['소설/시/희곡', '한국소설', '2000년대 한국소설']
 *
 * 맨 앞의 "국내도서"/"외국도서" 는 모든 항목에 붙는 값이라 정보가 없어 버립니다.
 */
export function parseCategories(raw) {
  return String(raw ?? '')
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== '국내도서' && s !== '외국도서' && s !== 'eBook')
    .slice(0, 6);
}

function trim(s, n) {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

function normalize(item) {
  const isbn13 = toIsbn13(item?.isbn13 || item?.isbn);
  const year = Number(String(item?.pubDate ?? '').slice(0, 4)) || null;

  // customerReviewRank 는 0~10 입니다. 다른 소스가 5점 만점이라 절반으로 맞춥니다.
  // 그래야 merge.mjs 의 점수 계산과 카드 표시가 일관됩니다.
  const rank = Number(item?.customerReviewRank);
  const rating =
    Number.isFinite(rank) && rank > 0
      ? { value: Math.round((rank / 2) * 10) / 10, count: 0, source: '알라딘' }
      : null;

  // 표지 URL 이 http 로 오는 경우가 있어 https 로 강제합니다.
  // 안 그러면 브라우저가 혼합 콘텐츠로 차단해 표지가 깨집니다.
  const cover = String(item?.cover ?? '').replace(/^http:/, 'https:');

  return {
    id: `al:${item?.itemId ?? isbn13 ?? Math.random().toString(36).slice(2)}`,
    title: String(item?.title ?? '').trim(),
    subtitle: '',
    authors: parseAuthors(item?.author),
    year,
    publisher: String(item?.publisher ?? '').trim(),
    isbn13: isbn13 ? [isbn13] : [],
    // 알라딘 기본 응답에는 페이지 수가 없습니다 (OptResult 를 요청해야 나오는데
    // 호출 비용 대비 효용이 낮아 생략했습니다). Google Books 쪽 값으로 병합됩니다.
    pageCount: null,
    categories: parseCategories(item?.categoryName),
    language: 'ko',
    description: trim(item?.description, 900),
    coverUrl: cover || null,
    rating,
    moods: [],
    genres: [],
    contentWarnings: [],
    series: null,
    freeEbook: null,
    links: {
      aladin: item?.link ?? null,
    },
    sources: ['aladin'],
  };
}
