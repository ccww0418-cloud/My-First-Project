/**
 * 장르 · 지역 사전과 주제 적합성 판정
 *
 * 왜 필요한가 (실측):
 *   "한국 스릴러" 를 검색어로 그대로 보내면 이런 일이 벌어집니다.
 *     · Open Library "한국 소설"  → 「한국 현대 소설 연구」, 「1960년대 한국 소설 연구」
 *                                   (소설이 아니라 소설 **연구서** 입니다)
 *     · Open Library "Korea"      → 「Pyongyang」, 「Korea's Place in the Sun」
 *                                   (한국사·정치·여행서)
 *     · Open Library subject=thriller → 「Treasure Island」(1880), 「Dracula」(1897)
 *                                   (전부 저작권 만료 고전)
 *
 *   원인이 둘입니다.
 *     1) "한국" 은 장르가 아니라 **언어/지역 조건** 인데 키워드로 나갑니다.
 *        키워드로 나가면 제목·주제에 "한국" 이 든 책(=한국학 서적)이 매칭됩니다.
 *     2) 정렬 점수에 **주제 적합성 항목이 없습니다.** 소스 수·표지·평점 같은
 *        "완성도" 만 보기 때문에, 잘 정리된 한국사 책이 갓 나온 스릴러를 항상 이깁니다.
 *
 *   이 모듈이 하는 일:
 *     · 질의에서 장르어와 지역어를 **분리**합니다 ("한국 스릴러" → ko + thriller)
 *     · 장르를 소스별 문법으로 **번역**합니다 (Google `subject:`, OL 슬러그, 알라딘 검색어)
 *     · 결과가 요청한 장르에 맞는지 **판정**합니다 (merge 의 정렬·필터가 이 값을 씁니다)
 *
 * 사전을 코드에 두는 이유:
 *   LLM 에게 "subject 는 영어로 넣어라" 라고 설명해도 실제로는 자연어를 그대로
 *   query 에 넣습니다. 도구 설명에만 의존하면 안 되고, 코드가 보정해야 합니다.
 */

// ────────────────────────────────────────────────────────────────
// 1. 장르 사전
// ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} GenreSpec
 * @property {string}   key       내부 식별자
 * @property {string[]} words     이 장르를 뜻하는 한국어·영어 표현 (질의 감지용)
 * @property {string}   gbSubject Google Books `subject:` 값 (BISAC 계열)
 * @property {string[]} olSubjects Open Library subject 슬러그 (앞이 우선)
 * @property {string}   hcQuery   Hardcover 검색용 영어 구문
 * @property {string}   aladin    알라딘 검색어 (한국어)
 * @property {string[]} match     결과가 이 장르인지 판정할 단어 (분류·장르·무드·제목에서 찾음)
 * @property {string[]} near      인접 장르 key. 국내 서점이 한 서가로 묶는 장르를 함께 인정합니다
 * @property {boolean}  fiction   소설류인가 (true 면 논픽션 결과를 강등)
 */

/** @type {GenreSpec[]} */
export const GENRES = [
  {
    key: 'thriller',
    words: ['스릴러', '서스펜스', '스릴러물', 'thriller', 'suspense'],
    gbSubject: 'Thrillers',
    olSubjects: ['thriller', 'suspense'],
    hcQuery: 'thriller suspense',
    aladin: '스릴러',
    match: ['thriller', 'suspense', '스릴러', '서스펜스'],
    near: ['mystery', 'crime', 'horror'],
    fiction: true,
  },
  {
    key: 'mystery',
    words: ['추리', '미스터리', '미스테리', '탐정', 'mystery', 'detective', 'whodunit'],
    gbSubject: 'Mystery & Detective',
    olSubjects: ['detective_and_mystery_stories', 'mystery'],
    hcQuery: 'mystery detective',
    aladin: '추리소설',
    match: ['mystery', 'detective', 'whodunit', '추리', '미스터리', '미스테리', '탐정'],
    near: ['thriller', 'crime'],
    fiction: true,
  },
  {
    key: 'crime',
    words: ['범죄', '느와르', '누아르', '하드보일드', 'crime', 'noir', 'hardboiled'],
    gbSubject: 'Crime',
    olSubjects: ['crime', 'detective_and_mystery_stories'],
    hcQuery: 'crime noir',
    aladin: '범죄소설',
    match: ['crime', 'noir', 'murder', '범죄', '느와르', '누아르', '살인'],
    near: ['thriller', 'mystery'],
    fiction: true,
  },
  {
    key: 'horror',
    words: ['호러', '공포', '괴담', '오컬트', 'horror', 'occult'],
    gbSubject: 'Horror',
    olSubjects: ['horror_tales', 'horror'],
    hcQuery: 'horror',
    aladin: '공포소설',
    match: ['horror', 'occult', 'ghost', '호러', '공포', '괴담'],
    near: ['thriller'],
    fiction: true,
  },
  {
    key: 'scifi',
    words: ['sf', 'SF', '공상과학', '과학소설', '사이버펑크', 'science fiction', 'sci-fi', 'cyberpunk'],
    gbSubject: 'Science Fiction',
    olSubjects: ['science_fiction'],
    hcQuery: 'science fiction',
    aladin: 'SF소설',
    match: ['science fiction', 'sci-fi', 'cyberpunk', 'dystopia', 'sf', '과학소설', '공상과학'],
    near: ['fantasy'],
    fiction: true,
  },
  {
    key: 'fantasy',
    words: ['판타지', '환상소설', 'fantasy'],
    gbSubject: 'Fantasy',
    olSubjects: ['fantasy'],
    hcQuery: 'fantasy',
    aladin: '판타지소설',
    match: ['fantasy', 'magic', '판타지', '환상'],
    near: ['scifi'],
    fiction: true,
  },
  {
    key: 'romance',
    words: ['로맨스', '연애소설', '멜로', 'romance', 'romantic'],
    gbSubject: 'Romance',
    olSubjects: ['love_stories', 'romance'],
    hcQuery: 'romance',
    aladin: '로맨스소설',
    match: ['romance', 'love stories', '로맨스', '연애'],
    near: [],
    fiction: true,
  },
  {
    key: 'historicalFiction',
    words: ['역사소설', '시대소설', 'historical fiction'],
    gbSubject: 'Historical',
    olSubjects: ['historical_fiction'],
    hcQuery: 'historical fiction',
    aladin: '역사소설',
    match: ['historical fiction', 'historical', '역사소설', '시대소설'],
    near: ['literary'],
    fiction: true,
  },
  {
    key: 'literary',
    words: ['문학소설', '순문학', '소설', 'literary fiction', 'novel', 'fiction'],
    gbSubject: 'Literary',
    olSubjects: ['fiction', 'literature'],
    hcQuery: 'literary fiction',
    aladin: '소설',
    match: ['literary', 'fiction', '소설', '문학'],
    near: [],
    fiction: true,
  },
  {
    key: 'youngadult',
    words: ['청소년', 'ya', 'YA', 'young adult'],
    gbSubject: 'Young Adult Fiction',
    olSubjects: ['young_adult_fiction', 'juvenile_fiction'],
    hcQuery: 'young adult',
    aladin: '청소년소설',
    match: ['young adult', 'juvenile', '청소년'],
    near: ['fantasy', 'literary'],
    fiction: true,
  },
  {
    key: 'essay',
    words: ['에세이', '산문', '수필', 'essay', 'essays'],
    gbSubject: 'Essays',
    olSubjects: ['essays'],
    hcQuery: 'essays',
    aladin: '에세이',
    match: ['essay', '에세이', '산문', '수필'],
    near: [],
    fiction: false,
  },
  {
    key: 'poetry',
    words: ['시집', '시', 'poetry', 'poems'],
    gbSubject: 'Poetry',
    olSubjects: ['poetry'],
    hcQuery: 'poetry',
    aladin: '시집',
    match: ['poetry', 'poems', '시집', '시'],
    near: [],
    fiction: false,
  },
  {
    key: 'selfhelp',
    words: ['자기계발', '자기개발', 'self-help', 'self help'],
    gbSubject: 'Self-Help',
    olSubjects: ['self-help'],
    hcQuery: 'self help',
    aladin: '자기계발',
    match: ['self-help', 'self help', 'motivation', '자기계발'],
    near: ['psychology'],
    fiction: false,
  },
  {
    key: 'philosophy',
    words: ['철학', 'philosophy'],
    gbSubject: 'Philosophy',
    olSubjects: ['philosophy'],
    hcQuery: 'philosophy',
    aladin: '철학',
    match: ['philosophy', '철학'],
    near: ['psychology'],
    fiction: false,
  },
  {
    key: 'psychology',
    words: ['심리학', '심리', 'psychology'],
    gbSubject: 'Psychology',
    olSubjects: ['psychology'],
    hcQuery: 'psychology',
    aladin: '심리학',
    match: ['psychology', '심리'],
    near: ['selfhelp'],
    fiction: false,
  },
  {
    key: 'science',
    words: ['과학', '교양과학', 'popular science'],
    gbSubject: 'Science',
    olSubjects: ['science'],
    hcQuery: 'popular science',
    aladin: '과학',
    match: ['science', '과학'],
    near: [],
    fiction: false,
  },
  {
    key: 'economics',
    words: ['경제', '경영', '재테크', 'economics', 'business'],
    gbSubject: 'Business & Economics',
    olSubjects: ['economics', 'business'],
    hcQuery: 'business economics',
    aladin: '경제경영',
    match: ['business', 'economics', 'finance', '경제', '경영'],
    near: ['selfhelp'],
    fiction: false,
  },
  {
    key: 'history',
    words: ['역사', '역사서', 'history'],
    gbSubject: 'History',
    olSubjects: ['history'],
    hcQuery: 'history',
    aladin: '역사',
    match: ['history', '역사'],
    near: [],
    fiction: false,
  },
  {
    key: 'biography',
    words: ['평전', '자서전', '전기', 'biography', 'memoir'],
    gbSubject: 'Biography & Autobiography',
    olSubjects: ['biography'],
    hcQuery: 'biography memoir',
    aladin: '평전',
    match: ['biography', 'autobiography', 'memoir', '평전', '자서전', '전기'],
    near: ['history'],
    fiction: false,
  },
  {
    key: 'travel',
    words: ['여행', '여행기', 'travel'],
    gbSubject: 'Travel',
    olSubjects: ['travel'],
    hcQuery: 'travel',
    aladin: '여행',
    match: ['travel', '여행'],
    near: [],
    fiction: false,
  },
  {
    key: 'comic',
    words: ['만화', '그래픽노블', '웹툰', 'comics', 'graphic novel', 'manga'],
    gbSubject: 'Comics & Graphic Novels',
    olSubjects: ['comics_and_graphic_novels'],
    hcQuery: 'graphic novel',
    aladin: '만화',
    match: ['comics', 'graphic novel', 'manga', '만화'],
    near: [],
    fiction: true,
  },
];

/**
 * 언어·지역 힌트.
 *
 * ★ 이 단어들을 검색 키워드에서 빼는 것이 이 모듈의 핵심입니다.
 *   "한국" 을 키워드로 남기면 제목·주제에 "한국" 이 든 책, 즉 한국학 서적이
 *   매칭됩니다. 실측에서 「Korea's Place in the Sun」(한국사), 「Korea」(여행서)가
 *   그렇게 올라왔습니다.
 */
const LOCALE_HINTS = [
  { lang: 'ko', words: ['한국', '국내', '한국어', '한글', '우리나라', 'korean', 'korea'] },
  { lang: 'ja', words: ['일본', '일본어', 'japanese'] },
  { lang: 'en', words: ['영어', '영미', '미국', '영국', 'english'] },
];

/**
 * ★ 학술·연구서 신호 (강한 배제).
 *
 * 이것들은 아래 FICTION_MARKERS 가 있어도 배제를 취소하지 않습니다.
 *
 * 왜 따로 두는가 (실측):
 *   「한국 현대 소설 연구」의 분류는 `Korean fiction | History and criticism` 입니다.
 *   즉 **소설에 대한 연구서**입니다. `fiction` 이 들어 있으니 소설 신호로 보면
 *   그대로 통과해 버립니다. 실제로 처음 구현에서 이 책이 걸러지지 않았습니다.
 *   "무엇에 대한 책" 과 "그 장르의 책" 은 다릅니다.
 */
const ACADEMIC_MARKERS = [
  'history and criticism', 'criticism and interpretation', 'literary criticism',
  'historiography', 'study and teaching', 'bibliography', 'dissertations',
  '연구', '비평', '평론', '논문', '개론', '교과서', '수험', '학술',
];

/**
 * 논픽션 신호 (약한 배제 — 소설 신호가 있으면 취소됩니다).
 *
 * 소설 장르를 요청했을 때 이런 분류가 붙은 책은 대개 오답입니다.
 * 실측에서 「Korea's Place in the Sun」(History), 「Korea」(Travel)가
 * 이것 때문에 걸러집니다.
 */
const NONFICTION_MARKERS = [
  'history', 'politics', 'political science', 'social science',
  'social conditions', 'travel', 'description and travel', 'guidebook',
  'language arts', 'education', 'reference', 'textbook',
  'business', 'economics', 'medical', 'health', 'cooking', 'religion',
  'biography & autobiography', 'antiques', 'law',
  // 한국어 분류 (알라딘 categoryName · 제목)
  '입문', '강의', '역사', '정치', '사회', '여행', '요리', '건강', '종교',
  '경제경영', '자격증',
];

/** 소설임을 뜻하는 신호. 논픽션 마커와 함께 있으면 이쪽을 우선합니다. */
const FICTION_MARKERS = [
  'fiction', 'novel', 'novels', 'short stories', 'stories',
  '소설', '장편', '단편', '중편',
];

// ────────────────────────────────────────────────────────────────
// 2. 질의 분해
// ────────────────────────────────────────────────────────────────

const lower = (s) => String(s ?? '').toLowerCase();

/** 단어 경계를 언어에 맞게 처리해서 포함 여부를 봅니다. */
function includesWord(haystack, word) {
  const h = lower(haystack);
  const w = lower(word);
  if (!h || !w) return false;
  // 한글·CJK 는 단어 경계가 없어 그냥 포함으로 봅니다.
  if (/[^\u0000-\u007f]/.test(w)) return h.includes(w);
  // 영문은 경계를 봐서 'sf' 가 'surface' 에 걸리는 것을 막습니다.
  return new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(h);
}

/**
 * 질의에서 장르를 찾습니다.
 *
 * 여러 개가 걸리면 **더 구체적인 쪽**을 고릅니다. "한국 스릴러 소설" 은
 * thriller 와 literary 가 둘 다 걸리는데, literary('소설')는 너무 넓어서
 * 사전 순서상 뒤에 두고 앞선 것을 우선합니다.
 *
 * @param {string} text
 * @returns {GenreSpec|null}
 */
export function detectGenre(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  for (const g of GENRES) {
    for (const w of g.words) {
      if (includesWord(t, w)) return g;
    }
  }
  return null;
}

/** 사전에서 key 로 찾습니다 (LLM 이 subject 를 영어로 넣은 경우 대응). */
export function genreByKeyOrWord(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const norm = v.replace(/_/g, ' ');
  for (const g of GENRES) {
    if (g.key === v) return g;
    if (lower(g.gbSubject) === lower(norm)) return g;
    if (g.olSubjects.includes(v) || g.olSubjects.includes(norm.replace(/\s+/g, '_'))) return g;
  }
  return detectGenre(norm);
}

/**
 * 질의에서 언어를 찾습니다.
 * @returns {string|null} ISO 639-1
 */
export function detectLocale(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  for (const h of LOCALE_HINTS) {
    for (const w of h.words) {
      if (includesWord(t, w)) return h.lang;
    }
  }
  return null;
}

/**
 * 장르어·지역어를 뺀 나머지를 돌려줍니다. 이게 실제 검색 키워드입니다.
 *
 *   "한국 스릴러"           → ""            (남는 키워드 없음 → 장르 검색만)
 *   "김초엽 SF 단편집"       → "김초엽 단편집"
 *   "요즘 나온 한국 추리소설" → "요즘 나온"
 */
export function stripHints(text) {
  let out = String(text ?? '');
  const words = [
    ...GENRES.flatMap((g) => g.words),
    ...LOCALE_HINTS.flatMap((h) => h.words),
  ];
  // 긴 단어부터 지워야 "추리소설" 을 "추리" 로 반쪽만 지우지 않습니다.
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    if (/[^\u0000-\u007f]/.test(w)) {
      out = out.split(w).join(' ');
    } else {
      out = out.replace(new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'gi'), ' ');
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 도구 입력을 한 번에 해석합니다.
 *
 * LLM 이 어디에 무엇을 넣었든(query 에 다 넣었든, subject 를 썼든)
 * 같은 결과가 나오도록 보정합니다.
 *
 * @param {{query?: string, subject?: string, title?: string, author?: string, language?: string}} input
 */
export function interpret(input = {}) {
  const raw = [input.query, input.subject, input.title].filter(Boolean).join(' ');

  // subject 를 명시했으면 그것을 우선 신뢰합니다.
  const genre = genreByKeyOrWord(input.subject) || detectGenre(raw);
  const language = normalizeLangCode(input.language) || detectLocale(raw);

  // 저자·제목은 지우지 않습니다. 지우면 "한강" 같은 고유명사가 사라집니다.
  const keywords = stripHints(input.query ?? '');

  return { genre, language, keywords, rawQuery: String(input.query ?? '').trim() };
}

function normalizeLangCode(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : null;
}

// ────────────────────────────────────────────────────────────────
// 3. 적합성 판정
// ────────────────────────────────────────────────────────────────

/**
 * 학술·연구서로 보이는지. 장르 요청과 무관하게 판정합니다.
 *
 * 왜 따로 내보내는가:
 *   present.mjs 가 카드 개수를 채울 때 씁니다. 답변이 언급하지 않은 책으로
 *   빈자리를 메우는데, 거기에 「한국 현대 소설 연구」 같은 연구서가 섞이면
 *   카드 선별을 만든 이유가 무의미해집니다.
 *   그 단계에는 장르 스펙이 없어서 classify() 를 쓸 수 없습니다.
 *
 * ★ 언급된 책에는 쓰지 마세요. 사용자가 연구서를 물었고 LLM 이 연구서를
 *   추천했다면 그건 정답입니다. 이 검사는 **채우는 책에만** 적용합니다.
 */
export function looksAcademic(book) {
  const hay = haystack(book);
  return ACADEMIC_MARKERS.some((w) => includesWord(hay, w));
}

/** 책에서 주제를 판단할 수 있는 텍스트를 모읍니다. */
function haystack(book) {
  return [
    book?.title,
    book?.subtitle,
    ...(book?.categories ?? []),
    ...(book?.genres ?? []),
    ...(book?.moods ?? []),
  ]
    .filter(Boolean)
    .join(' | ');
}

/**
 * 요청한 장르에 맞는 책인지 판정합니다.
 *
 * @param {object} book
 * @param {GenreSpec|null} genre
 * @returns {{fit: number, hasGenre: boolean, nonfiction: boolean, fictionSignal: boolean}}
 *   fit  2 = 장르 일치
 *        1 = 장르 신호는 없지만 배제 사유도 없음
 *        0 = 판단 불가 (분류 정보가 아예 없는 책)
 *       -1 = 요청과 어긋남 (소설을 원했는데 논픽션·연구서)
 */
export function classify(book, genre) {
  const hay = haystack(book);
  const hasAnyCategory = Boolean((book?.categories?.length ?? 0) || (book?.genres?.length ?? 0));

  const hasGenre = genre ? matchWordsOf(genre).some((w) => includesWord(hay, w)) : false;
  const academic = ACADEMIC_MARKERS.some((w) => includesWord(hay, w));
  const nonfiction = NONFICTION_MARKERS.some((w) => includesWord(hay, w));
  const fictionSignal = FICTION_MARKERS.some((w) => includesWord(hay, w));

  let fit;
  if (genre?.fiction && academic) {
    // 「한국 현대 소설 연구」처럼 그 장르를 **연구한** 책. 장르 신호가 있어도 오답입니다.
    fit = -1;
  } else if (hasGenre) {
    fit = 2;
  } else if (genre?.fiction && nonfiction && !fictionSignal) {
    // 소설을 원했는데 역사·여행서 → 명확한 오답
    fit = -1;
  } else if (!hasAnyCategory) {
    fit = 0; // 분류 정보가 없는 책. 낮게 두되 버리지는 않습니다.
  } else {
    fit = 1;
  }

  return { fit, hasGenre, academic, nonfiction, fictionSignal };
}

/**
 * 판정에 쓸 단어 목록 = 그 장르 + 인접 장르.
 *
 * 왜 인접 장르를 포함하는가 (실측):
 *   정유정 「종의 기원」의 알라딘 분류는 `추리/미스터리소설` 입니다.
 *   사용자는 "스릴러" 라고 물었는데 분류에는 "스릴러" 가 없어서 매칭에 실패했습니다.
 *   국내 서점은 스릴러·추리·미스터리·범죄를 사실상 한 서가로 묶습니다.
 *   장르를 너무 좁게 보면 맞는 책을 떨어뜨립니다.
 */
function matchWordsOf(genre) {
  if (!genre) return [];
  const words = [...genre.match];
  for (const key of genre.near ?? []) {
    const g = GENRES.find((x) => x.key === key);
    if (g) words.push(...g.match);
  }
  return [...new Set(words)];
}

/**
 * 정렬에 더할 적합성 점수.
 *
 * 값이 큰 이유: 기존 점수식에서 "소스 3곳 + 표지 + 평점" 이면 50점을 넘습니다.
 * 적합성이 그보다 작으면 여전히 한국사 책이 이깁니다. 주제가 맞는지는
 * 완성도보다 중요하므로 더 큰 가중치를 줍니다.
 *
 * @param {object} book
 * @param {{genre: GenreSpec|null, keywords?: string, language?: string|null}} spec
 */
export function relevanceScore(book, spec = {}) {
  const { genre, keywords, language } = spec;
  if (!genre && !keywords && !language) return 0;

  let s = 0;

  if (genre) {
    const { fit } = classify(book, genre);
    if (fit === 2) s += 60;
    else if (fit === 1) s += 0;
    else if (fit === 0) s -= 10;
    else s -= 80; // 명확한 오답
  }

  // 키워드가 제목에 있으면 강한 신호
  if (keywords) {
    const title = lower([book?.title, book?.subtitle].filter(Boolean).join(' '));
    const hits = keywords.split(/\s+/).filter((w) => w.length > 1 && title.includes(lower(w)));
    s += hits.length * 12;
  }

  // 요청 언어와 일치
  if (language) {
    if (book?.language && lower(book.language) === language) s += 14;
    else if (language === 'ko' && book?.sources?.includes('aladin')) s += 14;
  }

  return s;
}

/**
 * 명확한 오답을 걸러냅니다.
 *
 * ★ 하나도 남지 않을 때만 필터를 포기합니다.
 *
 *   기준을 3권으로 뒀다가 실패했습니다. 정답이 2권이면 "너무 많이 걸러졌다" 고
 *   판단해서 오답 4권을 되살렸고, 결국 한국사·여행서가 다시 카드에 실렸습니다.
 *
 *   맞는 책 2권이 맞는 책 2권 + 엉뚱한 책 4권보다 낫습니다.
 *   카드가 적은 것은 불편이지만, 엉뚱한 카드는 서비스에 대한 신뢰를 깎습니다.
 *
 *   0권이 되는 경우에만 전부 되살립니다. 0권을 받으면 LLM 이 검색어를 임의로
 *   바꿔 재시도하면서 주제를 더 크게 벗어나기 때문입니다
 *   (실측: "한국 스릴러" 0권 → "Korea" 재검색 → 한국사 책).
 *
 * @param {object[]} books
 * @param {GenreSpec|null} genre
 * @param {number} [keepAtLeast=1]
 * @returns {{books: object[], dropped: number}}
 */
export function dropMismatches(books, genre, keepAtLeast = 1) {
  if (!genre || !Array.isArray(books) || books.length === 0) {
    return { books: books ?? [], dropped: 0 };
  }

  const kept = books.filter((b) => classify(b, genre).fit >= 0);
  if (kept.length >= Math.max(1, Math.min(keepAtLeast, books.length))) {
    return { books: kept, dropped: books.length - kept.length };
  }
  // 하나도 남지 않았습니다 — 순서만 바뀐 상태로 전부 둡니다.
  return { books, dropped: 0 };
}
