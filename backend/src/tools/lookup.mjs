/**
 * 제목 + 저자 정확 조회 (생성 후 검증)
 *
 * ┌ 왜 이 방식이 필요한가 ────────────────────────────────────────┐
 * │  키워드 검색은 "한국 스릴러" 같은 요청을 못 다룹니다.            │
 * │  검색 엔진은 그것을 주제어로 읽고 한국을 **다룬** 책을 줍니다.    │
 * │  실측: Open Library "Korea" → 한국사·정치·여행서.               │
 * │                                                              │
 * │  그런데 LLM 은 "한국 스릴러" 가 정유정·김언수·서미애 라는 것을    │
 * │  이미 알고 있습니다. 그 지식을 검색어로 쓰는 대신                │
 * │  **책 이름 자체로** 쓰면 조회가 정확해집니다.                    │
 * │                                                              │
 * │    기존: 사용자 발화 → 키워드 검색 → 잡음 섞인 목록              │
 * │    이것: 사용자 발화 → LLM 이 제목·저자 지목 → 정확 조회 → 검증  │
 * └──────────────────────────────────────────────────────────────┘
 *
 * ★ 이 방식의 위험은 하나뿐입니다: LLM 이 없는 책을 만들어낼 수 있습니다.
 *   그래서 **검증이 이 모듈의 존재 이유**입니다.
 *   조회 결과의 제목·저자가 요청과 충분히 일치하지 않으면 버립니다.
 *   버려진 책은 카드로 나가지 않고, LLM 에게도 "확인 실패" 로 통보합니다.
 *   즉 환각은 "없는 책이 카드로 나가는 문제" 가 아니라
 *   "그 책만 빠지는 문제" 로 격하됩니다.
 *
 * 왜 단순 포함 검사로는 부족한가:
 *   · 부제가 붙습니다      「종의 기원」 vs 「종의 기원 (개정판)」
 *   · 번역 제목이 다릅니다  「The Vegetarian」 vs 「채식주의자」
 *   · 저자 표기가 다릅니다  「정유정」 vs 「정유정 (지은이)」
 *   그래서 문자 이중자(bigram) 기반 유사도를 씁니다. 한국어는 공백으로
 *   단어를 나누기 어려워 토큰 방식이 잘 듣지 않습니다.
 */

/** 비교용 정규화. merge 의 fuzzyKey 와 같은 원칙이지만 길이를 자르지 않습니다. */
export function normalizeForMatch(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      // ★ 한글 처리를 NFKD 앞에 둡니다.
      //   NFKD 는 한글을 자모로 분해하므로("지은이" → ㅈㅣㅇㅡㄴㅇㅣ)
      //   그 뒤에서는 한글 리터럴이 매칭되지 않습니다.
      //   순서를 잘못 뒀다가 역할 표기 제거가 조용히 무효화됐고,
      //   "정유정" vs "정유정 (지은이)" 가 0.59 로 떨어졌습니다.
      //
      // 판형·판차 표기는 같은 책을 다르게 보이게 만듭니다
      .replace(/\((?:개정|증보|합본|양장|리커버|특별|무선|초판)[^)]*\)/g, ' ')
      // 역할 표기 (알라딘 어댑터가 이미 떼지만 다른 소스에도 대비)
      .replace(/\(\s*(?:지은이|옮긴이|엮은이|글|그림|저|역|편|감수|원작)\s*\)/g, ' ')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(the|a|an|and|of)\b/g, ' ')
      .replace(/[^\p{L}\p{N}]/gu, '')
      // ★ 다시 조합형으로 돌립니다.
      //   NFKD 는 한글을 자모로 분해합니다. 그대로 반환하면 화면에는 "정유정" 으로
      //   보이지만 조합형 "정유정" 과 문자열 비교가 실패합니다. 이 함수끼리 비교할
      //   때는 양쪽이 같은 형태라 문제가 없지만, 값을 밖에서 쓰거나 저장하면
      //   설명할 수 없는 불일치가 생깁니다. 출력 형태를 예측 가능하게 만듭니다.
      .normalize('NFC')
  );
}

/**
 * 주제목만 떼어냅니다.
 *
 * 왜 필요한가:
 *   부제는 구분자(`:` `-` `(` `—`)로 붙습니다.
 *     「종의 기원: 정유정 장편소설」 → 주제목 "종의 기원"  (같은 책)
 *   반면 다른 책은 구분자 없이 이어집니다.
 *     「종의 기원과 진화론」        → 주제목 그대로       (다른 책)
 *
 *   구분자를 무시하고 "한쪽이 다른 쪽을 포함하면 같은 책" 으로 보면
 *   「종의 기원」과 「종의 기원과 진화론」이 같은 책이 됩니다. 실제로 그랬습니다.
 */
function mainTitle(s) {
  const t = String(s ?? '');
  const cut = t.search(/\s*[:\-–—(]\s*|\s*[:(]/);
  return cut > 0 ? t.slice(0, cut) : t;
}

/** 문자 이중자 집합. 한 글자짜리는 그대로 둡니다. */
function bigrams(s) {
  if (s.length <= 1) return new Set([s]);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * Dice 계수 유사도 (0~1).
 * 2 × 교집합 / (|A| + |B|)
 */
export function similarity(a, b) {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const A = bigrams(x);
  const B = bigrams(y);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return (2 * hit) / (A.size + B.size);
}

/**
 * 제목 일치 점수.
 *
 * 한쪽이 다른 쪽을 포함하면 높게 봅니다. 부제가 붙거나 빠지는 경우가 많고,
 * 그때 Dice 계수는 길이 차이 때문에 과도하게 떨어집니다.
 *   「종의 기원」(4자) vs 「종의 기원: 정유정 장편소설」(15자) → Dice 0.4
 * 이걸 불일치로 보면 맞는 책을 버립니다.
 */
export function titleScore(requested, candidate) {
  const a = normalizeForMatch(requested);
  const b = normalizeForMatch(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;

  // 부제를 떼고 주제목끼리 비교합니다.
  const ma = normalizeForMatch(mainTitle(requested));
  const mb = normalizeForMatch(mainTitle(candidate));
  if (ma && mb && ma === mb) return 1;

  // 주제목이 다르면 전체 문자열 유사도로 판단합니다.
  // 포함 관계를 근거로 점수를 주지 않습니다 — 「종의 기원」과
  // 「종의 기원과 진화론」이 같은 책으로 통과하기 때문입니다.
  return similarity(a, b);
}

/**
 * 저자 일치 점수.
 *
 * 여러 저자 중 하나만 맞아도 됩니다 — 번역서는 지은이·옮긴이가 함께 오고,
 * LLM 은 보통 지은이만 지목합니다.
 * 요청에 저자가 없으면 판단하지 않고 null 을 돌려줍니다(감점 없음).
 */
export function authorScore(requested, candidates = []) {
  const want = String(requested ?? '').trim();
  if (!want) return null;
  if (!candidates.length) return 0;
  return Math.max(...candidates.map((c) => similarity(want, c)));
}

/**
 * 후보 중에서 요청한 책을 고릅니다.
 *
 * @param {{title: string, author?: string}} requested
 * @param {object[]} candidates            여러 소스에서 온 정규화된 책 레코드
 * @param {{minTitle?: number, minAuthor?: number}} [opts]
 * @returns {{book: object, titleScore: number, authorScore: number|null}|null}
 */
export function pickBest(requested, candidates = [], opts = {}) {
  // 0.62 로 뒀다가 「종의 기원」 요청에 「종의 기원과 진화론」이 0.64 로 통과했습니다.
  // 같은 책은 주제목 비교로 1.00 이 나오므로 기준을 올려도 정상 케이스는 안 깨집니다.
  const minTitle = opts.minTitle ?? 0.7;
  const minAuthor = opts.minAuthor ?? 0.5;

  let best = null;
  for (const book of candidates) {
    if (!book?.title) continue;

    const ts = titleScore(requested.title, book.title);
    if (ts < minTitle) continue;

    const as = authorScore(requested.author, book.authors ?? []);
    // 저자를 지목했는데 전혀 다른 사람이면 **다른 책**입니다.
    // 같은 제목의 다른 책을 잡는 사고를 막는 지점입니다
    // (예: 「1984」는 조지 오웰 원작 외에 해설서·만화판이 많습니다).
    if (as !== null && as < minAuthor) continue;

    // 소스가 많고 표지·ISBN 이 있는 쪽을 선호합니다 (카드 품질).
    const bonus =
      (book.sources?.length ?? 1) * 0.02 +
      (book.coverUrl ? 0.03 : 0) +
      (book.isbn13?.length ? 0.03 : 0);

    const total = ts + (as ?? 0) * 0.35 + bonus;
    if (!best || total > best.total) {
      best = { book, titleScore: ts, authorScore: as, total };
    }
  }

  if (!best) return null;
  return { book: best.book, titleScore: best.titleScore, authorScore: best.authorScore };
}

/**
 * 요청 목록을 정규화합니다. LLM 이 형식을 조금씩 틀리게 넘겨도 받아냅니다.
 *
 * 받아들이는 형태:
 *   [{ title, author }]           정상
 *   ["종의 기원 - 정유정"]          문자열 (하이픈·쉼표로 분리)
 *   [{ title: "종의 기원" }]        저자 없음
 *
 * @returns {{title: string, author: string}[]}
 */
export function parseItems(raw, max = 8) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();

  for (const entry of list) {
    let title = '';
    let author = '';

    if (typeof entry === 'string') {
      // "종의 기원 - 정유정" / "종의 기원, 정유정" / "종의 기원 by 정유정"
      const m = entry.split(/\s+[-–—]\s+|\s*,\s*|\s+by\s+/i);
      title = (m[0] ?? '').trim();
      author = (m[1] ?? '').trim();
    } else if (entry && typeof entry === 'object') {
      title = String(entry.title ?? '').trim();
      author = String(entry.author ?? entry.authors ?? '').trim();
    }

    if (!title) continue;
    // 같은 책을 두 번 조회하지 않습니다 (호출 수 = 지연)
    const key = `${normalizeForMatch(title)}|${normalizeForMatch(author)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ title, author });
    if (out.length >= max) break;
  }

  return out;
}

/** 한글이 있으면 국내 도서로 봅니다 (소스 라우팅 판단). */
export function looksKorean(...parts) {
  return /[\uac00-\ud7a3]/.test(parts.filter(Boolean).join(' '));
}
