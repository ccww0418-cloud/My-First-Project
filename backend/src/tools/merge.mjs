/**
 * 다중 소스 병합 (이 프로젝트의 핵심 아이디어)
 *
 * 문제:
 *   Google Books / Open Library / Hardcover / Gutendex가 같은 책을 각자 다르게 돌려줍니다.
 *   그대로 LLM에 넘기면 같은 책이 4번 나오고, 토큰만 낭비하고, 추천도 중복됩니다.
 *
 * 해결: 2단계 매칭으로 하나의 레코드로 합칩니다.
 *   1단계 — ISBN-13 매칭 (정확). 소스마다 ISBN-10/13이 섞여 있어 전부 13으로 정규화.
 *   2단계 — fuzzy 키 매칭 (제목 정규화 + 첫 저자). ISBN이 없는 Gutenberg 책을 위한 폴백.
 *
 * 병합 규칙 (필드별로 "가장 신뢰할 수 있는 소스"를 우선):
 *   표지        Google Books > Hardcover > Open Library > Gutendex
 *   설명        가장 긴 것
 *   평점        Hardcover > Open Library > Google Books   (커뮤니티 규모/신뢰도 순)
 *   무드/경고    Hardcover only
 *   무료 전자책  Gutendex > Internet Archive(OL) > Google Books
 *   페이지 수    Google Books > Hardcover > Open Library
 *
 * 그리고 `compactForLlm()` 이 또 하나의 핵심입니다:
 *   전체 레코드는 프론트엔드로(카드 렌더용), 압축 요약만 LLM으로 보냅니다.
 *   권당 ~1200 토큰 → ~110 토큰. 입력 비용이 10분의 1로 줄고 응답도 빨라집니다.
 */

import { fuzzyKey } from '../lib/isbn.mjs';
import { relevanceScore, dropMismatches } from './genre.mjs';
import { log } from '../lib/log.mjs';

/**
 * @typedef {object} NormalizedBook
 * @property {string} id
 * @property {string} title
 * @property {string} subtitle
 * @property {string[]} authors
 * @property {number|null} year
 * @property {string} publisher
 * @property {string[]} isbn13
 * @property {number|null} pageCount
 * @property {string[]} categories
 * @property {string} language
 * @property {string} description
 * @property {string|null} coverUrl
 * @property {{value:number,count:number,source:string}|null} rating
 * @property {string[]} moods
 * @property {string[]} genres
 * @property {string[]} contentWarnings
 * @property {string|null} series
 * @property {object|null} freeEbook
 * @property {Record<string,string|null>} links
 * @property {string[]} sources
 */

// 국내 도서는 알라딘 표지가 가장 정확하고 큽니다(Cover=Big).
// 반대로 영미권 도서는 Google Books 가 낫습니다. 알라딘을 2순위에 둬서
// 국내서는 알라딘이(Google 이 표지를 못 주는 경우가 많음), 영미서는 Google 이 이깁니다.
// 국중(nlk)은 표지를 제공하지 않으므로 맨 뒤입니다.
const COVER_PRIORITY = ['googleBooks', 'aladin', 'hardcover', 'openLibrary', 'gutendex', 'nlk'];

// 알라딘 평점은 표본 수(count)를 주지 않아 신뢰도를 판단할 수 없습니다.
// 그래서 표본 수가 있는 소스들보다 뒤에 둡니다.
const RATING_PRIORITY = ['Hardcover', 'Open Library', 'Google Books', '알라딘'];

/**
 * 여러 소스의 결과 배열들을 하나의 중복 없는 목록으로 병합.
 *
 * @param {NormalizedBook[][]} groups  소스별 결과 배열
 * @param {number} [limit=8]
 * @param {{preferRecent?: boolean, relevance?: RelevanceSpec}} [opts]
 *        preferRecent — 신간 요청. 기본 점수식이 신간을 강등시키므로 가중치를 바꿉니다.
 *        relevance    — 요청한 장르·언어·키워드. 주제가 어긋난 결과를 내리고 걸러냅니다.
 *
 * @typedef {object} RelevanceSpec
 * @property {import('./genre.mjs').GenreSpec|null} [genre]
 * @property {string} [keywords]
 * @property {string|null} [language]
 * @returns {NormalizedBook[]}
 */
export function mergeBooks(groups, limit = 8, opts = {}) {
  /** @type {Map<string, NormalizedBook>} */
  const byKey = new Map();
  /** @type {Map<string, string>} isbn13 -> 대표 키 */
  const isbnIndex = new Map();
  /** @type {Map<string, string>} fuzzyKey -> 대표 키 */
  const fuzzyIndex = new Map();

  const order = [];

  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const book of group) {
      if (!book?.title) continue;

      const fk = fuzzyKey(book.title, book.authors?.[0]);
      let target = null;

      // 1단계: ISBN-13 매칭
      for (const isbn of book.isbn13 ?? []) {
        const hit = isbnIndex.get(isbn);
        if (hit) { target = hit; break; }
      }
      // 2단계: fuzzy 매칭
      if (!target && fk) {
        const hit = fuzzyIndex.get(fk);
        if (hit) target = hit;
      }

      if (target) {
        byKey.set(target, mergeInto(byKey.get(target), book));
        // 새로 알게 된 ISBN도 인덱스에 등록 (다음 소스가 붙을 수 있게)
        for (const isbn of book.isbn13 ?? []) if (!isbnIndex.has(isbn)) isbnIndex.set(isbn, target);
      } else {
        const key = book.isbn13?.[0] ? `isbn:${book.isbn13[0]}` : fk ? `fz:${fk}` : book.id;
        if (byKey.has(key)) {
          byKey.set(key, mergeInto(byKey.get(key), book));
        } else {
          byKey.set(key, { ...book, sources: [...(book.sources ?? [])] });
          order.push(key);
        }
        for (const isbn of book.isbn13 ?? []) if (!isbnIndex.has(isbn)) isbnIndex.set(isbn, key);
        if (fk && !fuzzyIndex.has(fk)) fuzzyIndex.set(fk, key);
      }
    }
  }

  const merged = order.map((k) => byKey.get(k)).filter(Boolean);
  const preferRecent = Boolean(opts.preferRecent);
  const rel = opts.relevance ?? null;

  // ★ 주제 적합성을 먼저 반영합니다.
  //
  //   이걸 넣기 전에는 "한국 스릴러" 요청에 한국사 책이 1위로 올라왔습니다.
  //   기존 점수식이 "여러 DB 에 잘 등재되고 표지·평점이 있는 책" 을 뽑기 때문입니다.
  //   한국학 서적은 오래돼서 그 조건을 모두 만족하고, 갓 나온 스릴러는 못 합니다.
  //   주제가 맞는지는 완성도보다 중요하므로 더 큰 가중치를 줍니다.
  const withRel = rel
    ? merged.map((b) => ({ book: b, rel: relevanceScore(b, rel) }))
    : merged.map((b) => ({ book: b, rel: 0 }));

  withRel.sort((x, y) => (score(y.book, preferRecent) + y.rel) - (score(x.book, preferRecent) + x.rel));

  let ordered = withRel.map((x) => x.book);

  // 명확한 오답(소설 요청에 역사서·연구서)은 정렬만으로 부족합니다.
  // 8권 안에 들어오면 여전히 카드로 보이므로 잘라냅니다.
  if (rel?.genre) {
    const { books: kept, dropped } = dropMismatches(ordered, rel.genre);
    if (dropped > 0) {
      log.info('주제 불일치 제외', { genre: rel.genre.key, dropped, kept: kept.length });
    }
    ordered = kept;
  }

  return ordered.slice(0, limit).map(finalize);
}

function mergeInto(base, incoming) {
  const out = { ...base };

  out.sources = [...new Set([...(base.sources ?? []), ...(incoming.sources ?? [])])];

  // 제목/부제: 더 긴(= 정보가 많은) 쪽
  if ((incoming.title?.length ?? 0) > (out.title?.length ?? 0) && incoming.sources?.includes('googleBooks')) {
    out.title = incoming.title;
  }
  out.subtitle = out.subtitle || incoming.subtitle || '';

  out.authors = uniq([...(out.authors ?? []), ...(incoming.authors ?? [])]).slice(0, 5);
  out.isbn13 = uniq([...(out.isbn13 ?? []), ...(incoming.isbn13 ?? [])]);
  out.categories = uniq([...(out.categories ?? []), ...(incoming.categories ?? [])]).slice(0, 12);

  out.year = out.year ?? incoming.year ?? null;
  out.publisher = out.publisher || incoming.publisher || '';
  out.language = out.language || incoming.language || '';

  // 설명: 더 긴 쪽
  if ((incoming.description?.length ?? 0) > (out.description?.length ?? 0)) {
    out.description = incoming.description;
  }

  // 페이지 수: 우선순위 소스 값이 있으면 채움
  out.pageCount = out.pageCount ?? incoming.pageCount ?? null;

  // 표지: 우선순위 비교
  out.coverUrl = pickCover(out, incoming);

  // 평점: 신뢰도 우선순위
  out.rating = pickRating(out.rating, incoming.rating);

  // Hardcover 전용 필드는 있는 쪽을 채택
  out.moods = pickNonEmpty(out.moods, incoming.moods);
  out.genres = pickNonEmpty(out.genres, incoming.genres);
  out.contentWarnings = pickNonEmpty(out.contentWarnings, incoming.contentWarnings);
  out.series = out.series ?? incoming.series ?? null;
  out.seriesPosition = out.seriesPosition ?? incoming.seriesPosition ?? null;
  out.hasAudiobook = out.hasAudiobook || incoming.hasAudiobook || false;
  out.hasEbook = out.hasEbook || incoming.hasEbook || false;
  out.readersCount = out.readersCount ?? incoming.readersCount ?? null;

  // 무료 전자책: Gutenberg가 최우선 (실제 원문 파일을 주니까)
  out.freeEbook = pickFreeEbook(out.freeEbook, incoming.freeEbook);

  out.links = { ...(out.links ?? {}), ...compactLinks(incoming.links) };

  return out;
}

function pickCover(a, b) {
  const rank = (book) => {
    if (!book?.coverUrl) return 99;
    const idx = COVER_PRIORITY.findIndex((s) => book.sources?.includes(s));
    return idx === -1 ? 50 : idx;
  };
  if (!a.coverUrl) return b.coverUrl ?? null;
  if (!b.coverUrl) return a.coverUrl;
  return rank(b) < rank(a) ? b.coverUrl : a.coverUrl;
}

function pickRating(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const rank = (r) => {
    const i = RATING_PRIORITY.indexOf(r.source);
    return i === -1 ? 99 : i;
  };
  return rank(b) < rank(a) ? b : a;
}

function pickFreeEbook(a, b) {
  const rank = (f) => {
    if (!f) return 99;
    if (f.source === 'Project Gutenberg') return 0;
    if (f.source === 'Internet Archive') return 1;
    return 2;
  };
  return rank(b) < rank(a) ? b : a ?? b ?? null;
}

function pickNonEmpty(a, b) {
  if (Array.isArray(a) && a.length) return a;
  return Array.isArray(b) && b.length ? b : a ?? [];
}

function compactLinks(links = {}) {
  const out = {};
  for (const [k, v] of Object.entries(links)) if (v) out[k] = v;
  return out;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean).map((s) => String(s).trim()))];
}

/**
 * 정렬 점수
 *
 * 기본 모드 — "여러 소스가 동시에 아는 책" = 실제로 유명하고 구하기 쉬운 책이라는 신호.
 *
 * ⚠️ 신간 모드(preferRecent)가 왜 따로 필요한가:
 *   기본 점수식의 세 항목이 **구조적으로 신간을 강등**시킵니다.
 *     · sources.length * 12  — 신간은 아직 DB 3~4곳에 다 등재되지 않아 보통 1곳뿐 (−24~36점)
 *     · rating.count > 100    — 갓 나온 책은 평가자가 100명 미만 (−5점)
 *     · moods.length          — Hardcover 무드 태그는 독자가 붙이므로 신간엔 비어 있음 (−6점)
 *   합치면 신간이 고전보다 40점 가까이 불리합니다. API에서 신간을 잘 가져와도
 *   이 정렬에서 8권 밖으로 밀려나 사용자에게 안 보였습니다.
 *
 *   그래서 신간 요청일 때는 소스 수 가중치를 낮추고, 평가자 수 보너스를 없애고,
 *   출간연도 보너스를 넣습니다.
 *
 * @param {NormalizedBook} book
 * @param {boolean} [preferRecent=false]
 */
function score(book, preferRecent = false) {
  let s = 0;

  // 교차 검증 가산 — 신간 모드에서는 영향력을 1/3로 줄임
  s += (book.sources?.length ?? 1) * (preferRecent ? 4 : 12);

  if (book.coverUrl) s += 8; // 표지 있으면 UI가 예쁨
  if (book.rating?.value) s += Math.min(book.rating.value, 5) * 3;
  if (book.freeEbook) s += 4;
  if (book.description) s += 3;

  if (preferRecent) {
    // 평가자 수 보너스는 정의상 오래된 책만 받으므로 신간 모드에서 제외
    if (book.moods?.length) s += 2;
    s += recencyBonus(book.year);
  } else {
    if (book.rating?.count > 100) s += 5;
    if (book.moods?.length) s += 6; // 추천 근거를 댈 수 있음
  }

  return s;
}

/** 출간연도가 최근일수록 가산. 연도 불명은 신간 요청에서 신뢰할 수 없으므로 감점. */
function recencyBonus(year) {
  if (!year) return -10;

  const now = new Date().getFullYear();
  // 메타데이터 오류 방어: 내년보다 더 미래면(9999년 등) 신뢰하지 않음.
  // Open Library 에서 first_publish_year 가 9999/2312 인 레코드를 실제로 확인했습니다.
  if (year > now + 1) return -20;

  const age = now - year;
  if (age <= 0) return 45; // 올해 또는 예약 출간
  if (age === 1) return 35;
  if (age === 2) return 22;
  if (age <= 4) return 10;
  if (age >= 15) return -15; // 고전은 뒤로
  return 0;
}

function finalize(book) {
  // Google Books 링크는 있으면 좋지만 없어도 되므로 정리만
  return {
    ...book,
    authors: book.authors?.length ? book.authors : ['(저자 정보 없음)'],
    links: compactLinks(book.links),
  };
}

/**
 * ★ 토큰 절약의 핵심 ★
 * LLM에게는 판단에 필요한 최소 정보만 보냅니다.
 * 표지 URL, 긴 설명, 각종 링크는 LLM이 볼 필요가 없습니다 (프론트가 렌더링하니까).
 *
 * 결과: 권당 약 1200 토큰 → 약 110 토큰
 *
 * @param {NormalizedBook[]} books
 * @returns {string} LLM에 넣을 컴팩트 텍스트
 */
export function compactForLlm(books) {
  if (!books.length) return '결과 없음.';

  const lines = books.map((b, i) => {
    const bits = [
      `[${i + 1}] "${b.title}${b.subtitle ? `: ${b.subtitle}` : ''}"`,
      `저자: ${b.authors.slice(0, 2).join(', ')}`,
    ];
    if (b.year) bits.push(`${b.year}년`);
    if (b.pageCount) bits.push(`${b.pageCount}p`);
    if (b.rating) bits.push(`평점 ${b.rating.value}/5(${b.rating.count}명, ${b.rating.source})`);
    if (b.genres?.length) bits.push(`장르: ${b.genres.slice(0, 4).join('/')}`);
    else if (b.categories?.length) bits.push(`분류: ${b.categories.slice(0, 3).join('/')}`);
    if (b.moods?.length) bits.push(`무드: ${b.moods.slice(0, 4).join('/')}`);
    if (b.contentWarnings?.length) bits.push(`주의: ${b.contentWarnings.slice(0, 3).join('/')}`);
    if (b.series) bits.push(`시리즈: ${b.series}${b.seriesPosition ? ` #${b.seriesPosition}` : ''}`);
    if (b.freeEbook) bits.push(`무료전문(${b.freeEbook.source})`);
    if (b.isbn13?.[0]) bits.push(`ISBN ${b.isbn13[0]}`);
    bits.push(`출처: ${b.sources.join('+')}`);

    // 설명은 첫 140자만 (LLM이 톤을 파악하는 데 충분)
    const desc = b.description ? ` — ${b.description.slice(0, 140)}` : '';
    return bits.join(' | ') + desc;
  });

  return lines.join('\n');
}
