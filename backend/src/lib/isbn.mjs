/**
 * ISBN 정규화 / 변환 / 검증
 *
 * 왜 필요한가:
 *   4개 API가 같은 책을 서로 다른 형태로 돌려줍니다.
 *     - Google Books: industryIdentifiers[{ type:'ISBN_13', identifier:'9780141439518' }]
 *     - Open Library: isbn: ['0141439518', '9780141439518', ...]
 *     - Hardcover:    isbns: ['9780141439518', ...]
 *     - Gutendex:     ISBN 없음 (Gutenberg ID만)
 *   ISBN-10과 ISBN-13이 섞여 있고, 하이픈/공백/소문자 x가 들어있기도 합니다.
 *   전부 ISBN-13으로 정규화해야 소스 간 조인(병합)이 가능합니다.
 */

/** 하이픈·공백 제거, 대문자 X */
export function clean(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

function isbn10CheckDigit(first9) {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(first9[i]);
  const r = (11 - (sum % 11)) % 11;
  return r === 10 ? 'X' : String(r);
}

function isbn13CheckDigit(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

export function isValidIsbn10(s) {
  const c = clean(s);
  return /^\d{9}[\dX]$/.test(c) && isbn10CheckDigit(c.slice(0, 9)) === c[9];
}

export function isValidIsbn13(s) {
  const c = clean(s);
  return /^\d{13}$/.test(c) && isbn13CheckDigit(c.slice(0, 12)) === c[12];
}

/** ISBN-10 → ISBN-13 */
export function toIsbn13(raw) {
  const c = clean(raw);
  if (/^\d{13}$/.test(c)) return isValidIsbn13(c) ? c : '';
  if (/^\d{9}[\dX]$/.test(c)) {
    if (!isValidIsbn10(c)) return '';
    const core = `978${c.slice(0, 9)}`;
    return core + isbn13CheckDigit(core);
  }
  return '';
}

/**
 * 여러 후보 중 유효한 ISBN-13 목록을 뽑아 중복 제거.
 * @param {Array<string|{identifier?:string,type?:string}>} candidates
 * @returns {string[]}
 */
export function collectIsbn13(candidates = []) {
  const set = new Set();
  for (const c of candidates) {
    const raw = typeof c === 'string' ? c : c?.identifier;
    const v = toIsbn13(raw);
    if (v) set.add(v);
  }
  return [...set];
}

/**
 * ISBN이 없는 책(Gutenberg 등)도 병합할 수 있게 만드는 폴백 키.
 * 제목 + 첫 저자를 정규화해서 만듭니다.
 * 완벽하지 않지만(동명이 다른 판본), 무료 전자책 매칭에는 충분히 실용적입니다.
 */
export function fuzzyKey(title, author = '') {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // 발음 구별 기호 제거
      .replace(/\b(the|a|an)\b/g, '')
      // 예전에는 [^a-z0-9가-힣] 였습니다. 라틴/한글만 남기므로 일본어·중국어·
      // 키릴·아랍어 제목은 키가 빈 문자열이 되고, 그러면 ISBN 없는 레코드가
      // 병합되지 않아 같은 책이 카드로 여러 번 나왔습니다.
      // UI 기본 언어를 영어로 바꾼 뒤 비한국어 도서 비중이 늘어 실제로 드러납니다.
      // \p{L}(모든 문자) + \p{N}(모든 숫자)로 바꿔 언어 중립적으로 만듭니다.
      .replace(/[^\p{L}\p{N}]/gu, '');
  const t = norm(title).slice(0, 40);
  const a = norm(author).slice(0, 20);
  return t ? `T:${t}|A:${a}` : '';
}
