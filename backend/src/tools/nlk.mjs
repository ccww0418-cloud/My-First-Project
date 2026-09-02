/**
 * 국립중앙도서관 소장자료 검색 API
 * https://www.nl.go.kr/NL/contents/N31101030700.do
 *
 * 이 프로젝트에서의 역할: **국내 도서의 서지 기준점**
 *   알라딘은 서점이라 "지금 판매하는 책" 을 잘 압니다. 절판된 책, 오래된
 *   국내서, 학술서는 약합니다. 국립중앙도서관은 납본 기관이라 **국내에서
 *   출간된 책이 사실상 전부** 있습니다. 두 소스는 겹치지 않고 보완합니다.
 *
 *   알라딘  — 신간·베스트셀러·표지·구매 링크
 *   국중    — 절판·구간·학술서·KDC 분류·ISBN
 *
 * ⚠️ 함정 세 가지 (실측)
 *
 *   1) **오류도 HTTP 200 으로 옵니다.** 알라딘과 같습니다.
 *      키 없이 호출:  {"errorCode":"010","errorMsg":"NO KEY VALUE:..."}
 *      틀린 키:       {"errorCode":"011","errorMsg":"INVALID KEY:..."}
 *      둘 다 상태 코드는 200 입니다. `if (!res.ok)` 만 보면 오류를 성공으로 착각합니다.
 *
 *   2) **한글 파라미터를 반드시 인코딩해야 합니다.**
 *      공식 문서에 "URL(한글)은 반드시 인코딩해야 함" 이라고 적혀 있습니다.
 *      systemType=오프라인자료 처럼 값 자체가 한글입니다.
 *
 *   3) **kwd 와 상세검색(detailSearch)을 섞을 수 없습니다.**
 *      문서: "Kwd 값과 상세검색 값은 혼용하여 사용이 불가능".
 *      제목+저자로 정확히 찾을 때는 detailSearch 쪽만 씁니다.
 *
 * 표지 이미지가 없습니다. 도서관 서지 데이터라 표지를 제공하지 않습니다.
 * 그래서 알라딘·Google Books 와 병합될 때 표지를 그쪽에서 받습니다.
 */

import { fetchJson, buildUrl } from '../lib/http.mjs';
import { collectIsbn13, toIsbn13 } from '../lib/isbn.mjs';
import { log } from '../lib/log.mjs';

const ENDPOINT = 'https://www.nl.go.kr/NL/search/openApi/search.do';

/** 오류 코드 → 사람이 읽을 설명 (로그 진단용) */
const ERRORS = {
  '000': '국중 시스템 오류',
  '010': '인증키 누락',
  '011': '유효하지 않은 인증키',
  '012': '500건 초과 조회 불가',
  '013': '카테고리 값 오류',
  '014': '파라미터 값 오류',
  '015': '검색어 또는 상세검색 값 누락',
  101: '국중 검색 서버 오류',
};

/**
 * 키워드 검색.
 *
 * @param {object} p
 * @param {string} p.query        검색어
 * @param {string} p.key          발급키
 * @param {number} [p.limit=8]
 * @param {'total'|'title'|'author'|'publisher'} [p.target='total']
 * @param {boolean} [p.recent]    발행연도 내림차순
 * @returns {Promise<import('./merge.mjs').NormalizedBook[]>}
 */
export async function searchNlk({ query, key, limit = 8, target = 'total', recent = false } = {}) {
  const kwd = String(query ?? '').trim();
  // 키가 없으면 조용히 빈 배열입니다. 나머지 소스로 답이 나가야 합니다.
  if (!key || !kwd) return [];

  return request(
    {
      key,
      apiType: 'json',
      srchTarget: target,
      kwd,
      pageNum: 1,
      pageSize: Math.min(Math.max(limit, 1), 100),
      // ⚠️ category 를 보내지 않습니다.
      //
      //   처음에는 `category: '도서'` 를 넣어 고문헌·비도서를 걸렀습니다.
      //   그런데 배포 후 국중 결과가 **0건**이었습니다. 키는 로드됐고 호출도
      //   됐는데 아무것도 안 왔습니다. 공식 문서의 category 값 목록이
      //   잘려 있어(도서, 고문헌, …) 정확한 문자열을 확신할 수 없었고,
      //   값이 틀리면 errorCode 013(CATEGORY ERROR)으로 조용히 0건이 됩니다.
      //
      //   선택 파라미터 하나 때문에 소스 전체를 잃는 것은 나쁜 거래입니다.
      //   그래서 보내지 않고, 필요하면 결과에서 걸러냅니다.
      ...(recent ? { sort: 'pubYear', order: 'desc' } : {}),
    },
    { label: 'nlk.search', limit },
  );
}

/**
 * 제목 + 저자 정확 조회 (lookup_books 용).
 *
 * ★ kwd 를 함께 보내지 않습니다. 문서가 혼용을 금지합니다.
 *   f1/v1, f2/v2 형식으로 필드별 조건을 넘깁니다.
 */
export async function lookupNlk({ title, author, key, limit = 5 } = {}) {
  const t = String(title ?? '').trim();
  if (!key || !t) return [];

  const params = {
    key,
    apiType: 'json',
    detailSearch: 'true',
    pageNum: 1,
    pageSize: Math.min(Math.max(limit, 1), 100),
    f1: 'title',
    v1: t,
  };
  const a = String(author ?? '').trim();
  if (a) {
    params.f2 = 'author';
    params.v2 = a;
  }

  return request(params, { label: 'nlk.lookup', limit });
}

/** ISBN 조회 */
export async function lookupNlkByIsbn({ isbn, key, limit = 3 } = {}) {
  const code = String(isbn ?? '').replace(/[^0-9Xx]/g, '');
  if (!key || !code) return [];

  return request(
    {
      key,
      apiType: 'json',
      detailSearch: 'true',
      isbnOp: 'isbn',
      isbnCode: code,
      pageNum: 1,
      pageSize: Math.min(Math.max(limit, 1), 100),
    },
    { label: 'nlk.isbn', limit },
  );
}

// ────────────────────────────────────────────────────────────────

/** 파라미터 값이 문제일 때 나오는 코드 — 이때는 선택 파라미터를 떼고 다시 시도합니다 */
const PARAM_ERRORS = new Set(['013', '014']);

/** 없어도 검색이 되는 파라미터. 재시도 때 이것들을 떼어냅니다. */
const OPTIONAL = ['category', 'sort', 'order', 'systemType', 'licYn', 'govYn'];

async function request(params, { label, limit }) {
  const first = await once(params, label);

  // ★ 선택 파라미터 때문에 실패했다면 그것만 떼고 한 번 더 시도합니다.
  //
  //   왜 필요한가: 이 API 는 파라미터 값이 조금 틀려도
  //   errorCode 013/014 를 **HTTP 200** 으로 돌려줍니다. 그러면 소스 전체가
  //   조용히 0건이 됩니다. 실제로 `category=도서` 하나 때문에 국중 결과가
  //   전부 0건이었고, 로그를 보지 않으면 알 수 없었습니다.
  //   선택 파라미터를 지키려고 소스를 잃는 것은 나쁜 거래입니다.
  if (first.error && PARAM_ERRORS.has(String(first.error))) {
    const stripped = { ...params };
    const removed = OPTIONAL.filter((k) => k in stripped);
    for (const k of removed) delete stripped[k];

    if (removed.length) {
      log.warn('국중 파라미터 오류 — 선택 파라미터를 떼고 재시도', {
        label, errorCode: first.error, removed,
      });
      const second = await once(stripped, `${label}.retry`);
      if (!second.error) return finish(second.items, limit);
    }
  }

  if (first.error) return [];
  return finish(first.items, limit);
}

/** 한 번 호출하고 { items, error } 를 돌려줍니다. 예외를 밖으로 던지지 않습니다. */
async function once(params, label) {
  // buildUrl 이 encodeURIComponent 를 적용합니다 — 한글 값이 있어 필수입니다.
  const url = buildUrl(ENDPOINT, params);

  let data;
  try {
    data = await fetchJson(url, { label, retries: 1 });
  } catch (err) {
    log.warn('국중 검색 실패', { label, status: err.status, body: err.bodySnippet });
    return { items: [], error: 'http' };
  }

  // ★ 오류도 HTTP 200 입니다. 본문을 직접 확인합니다.
  if (data?.errorCode) {
    log.warn('국중 오류 응답', {
      label,
      errorCode: data.errorCode,
      meaning: ERRORS[data.errorCode] ?? '알 수 없는 코드',
      errorMsg: String(data.errorMsg ?? '').slice(0, 120),
    });
    return { items: [], error: String(data.errorCode) };
  }

  const items = Array.isArray(data?.result) ? data.result : [];
  // 0건도 로그에 남깁니다. "호출은 됐는데 결과가 없다" 와
  // "아예 호출되지 않았다" 를 로그로 구분할 수 있어야 합니다.
  log.debug('국중 응답', { label, total: data?.total, received: items.length });
  return { items, error: null };
}

function finish(items, limit) {
  return items.map(normalize).filter((b) => b.title).slice(0, limit);
}

/**
 * 국중 레코드를 프로젝트 공통 형태로.
 *
 * ISBN 필드에 두 개가 붙어 오는 경우가 있어(ISBN10 ISBN13) 공백·쉼표로 나눕니다.
 */
function normalize(r) {
  const rawIsbn = String(r?.isbn ?? '').trim();
  const isbnParts = rawIsbn.split(/[\s,;]+/).filter(Boolean);
  const isbn13 = collectIsbn13(isbnParts.map((v) => ({ identifier: v })));
  // collectIsbn13 이 형식을 못 맞추면 직접 변환을 시도합니다
  if (!isbn13.length) {
    for (const v of isbnParts) {
      const c = toIsbn13(v);
      if (c) isbn13.push(c);
    }
  }

  const year = Number(String(r?.pub_year_info ?? '').match(/\d{4}/)?.[0]) || null;

  return {
    id: `nlk:${r?.controlNo ?? r?.detail_link ?? rawIsbn ?? Math.random().toString(36).slice(2)}`,
    title: cleanTitle(r?.title_info),
    subtitle: '',
    authors: parseAuthors(r?.author_info),
    year,
    publisher: String(r?.pub_info ?? '').trim(),
    isbn13,
    pageCount: null,
    // KDC 대분류를 분류로 씁니다 — 장르 적합성 판정(genre.mjs)이 이 값을 봅니다.
    categories: [String(r?.kdc_name_1s ?? '').trim()].filter(Boolean),
    language: 'ko',
    description: '',
    // 도서관 서지에는 표지가 없습니다. 병합 시 알라딘·Google 쪽에서 받습니다.
    coverUrl: null,
    rating: null,
    moods: [],
    genres: [],
    contentWarnings: [],
    series: null,
    freeEbook: null,
    links: {
      nlk: r?.detail_link ? absolute(r.detail_link) : null,
    },
    sources: ['nlk'],
  };
}

/**
 * 제목 정제.
 * 국중 표제에는 책임표시가 ` / ` 뒤에 붙습니다.
 *   "토지 / 박경리 지음" → "토지"
 * 그대로 두면 병합 키가 어긋나 같은 책이 카드 두 장으로 나옵니다.
 */
function cleanTitle(raw) {
  return String(raw ?? '')
    .replace(/\s*\/.*$/, '')
    .replace(/\s*=\s*[^=]*$/, '') // 병기 표제(= Romanized title) 제거
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 저자 정제.
 * 국중 저작자 표기: "박경리 지음", "요한 하리 지음 ; 김하현 옮김"
 * 알라딘의 parseAuthors 와 같은 원칙입니다 — 역할 표기를 떼고 지은이를 앞으로.
 */
export function parseAuthors(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];

  const parts = s
    .split(/\s*[;,]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  const scored = parts.map((p) => {
    const isAuthor = /지음|저$|편저|글$|원작|著/.test(p);
    const name = p
      .replace(/\s*(지음|옮김|엮음|편저|편|저|역|글|그림|원작|감수|著|譯)\s*$/g, '')
      .replace(/\s*\[.*?\]\s*/g, '')
      .trim();
    return { name, isAuthor };
  });

  return [
    ...scored.filter((x) => x.isAuthor).map((x) => x.name),
    ...scored.filter((x) => !x.isAuthor).map((x) => x.name),
  ]
    .filter(Boolean)
    .slice(0, 5);
}

function absolute(link) {
  const s = String(link);
  if (/^https?:\/\//.test(s)) return s;
  return `https://www.nl.go.kr${s.startsWith('/') ? '' : '/'}${s}`;
}
