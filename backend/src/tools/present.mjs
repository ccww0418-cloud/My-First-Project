/**
 * 카드 선별 — 답변에서 실제로 언급한 책만 카드로 내보냅니다
 *
 * ══════════════════════════════════════════════════════════════
 * 왜 필요한가 (실측)
 * ══════════════════════════════════════════════════════════════
 * 예전에는 도구가 찾은 책이 **LLM 을 거치지 않고 그대로** 카드가 되었습니다.
 *
 *   질문: "박경리 토지 같은 한국 대하소설 추천해줘"
 *   카드: 26권  (「혼불 1」~「혼불 6」이 각각 별도 카드)
 *   답변: "《태백산맥》 … 이 세 작품을 강력히 추천드립니다"
 *
 * 카드 26장 중 23장은 LLM 이 언급조차 하지 않은 책이었습니다.
 * 사용자는 "왜 이 책들이 나왔지" 를 알 수 없고, 답변과 카드가 어긋납니다.
 *
 * ══════════════════════════════════════════════════════════════
 * 왜 도구를 새로 만들지 않았는가
 * ══════════════════════════════════════════════════════════════
 * "LLM 이 present_books 도구로 번호를 골라 돌려준다" 를 먼저 검토했습니다. 버렸습니다.
 *   · 도구 반복 예산이 3회입니다(API Gateway 통합 타임아웃 30초 대응).
 *     검색 2회 + 선별 1회면 답변 쓸 라운드가 없습니다.
 *   · LLM 이 호출을 빼먹으면 전체가 무너집니다. 프롬프트 준수에 의존하게 됩니다.
 *   · 왕복이 한 번 늘어 지연과 토큰이 증가합니다.
 *
 * 대신 **이미 생성된 답변 텍스트**를 근거로 씁니다.
 * LLM 은 어차피 추천하는 책의 제목을 답변에 적습니다(프롬프트가 원제를 요구).
 * 그 제목과 도구 결과를 맞춰보면 추가 비용 0 으로 정렬이 맞습니다.
 */

import { normalizeForMatch } from './lookup.mjs';
import { looksAcademic } from './genre.mjs';
import { log } from '../lib/log.mjs';

/**
 * 답변에 아무 책도 못 맞췄을 때 보여줄 최대 권수.
 *
 * 답변에서 10권 이상 추천하게 바꿨으므로 폴백도 그에 맞춥니다.
 * 폴백은 매칭이 실패한 비정상 경로지만, 그때 6권만 보여주면
 * "추천은 10권인데 카드는 6장" 이 되어 더 어색합니다.
 */
const FALLBACK_LIMIT = 12;

/**
 * 카드 최소 개수.
 *
 * 답변이 언급한 책이 이보다 적으면 남은 후보로 채웁니다.
 *
 * 왜 필요한가 (실측): 검색이 18~40권을 물어오는데 답변은 5~9권만 언급했습니다.
 *   total 40 → presented 8,  total 25 → presented 5.
 *   "탐색은 14권을 찾았는데 카드는 5장" 이 되면 찾은 것을 버리는 셈입니다.
 *
 * 언급된 책을 밀어내지 않습니다 — 앞에 두고 뒤를 채웁니다.
 * 후보가 이보다 적으면 있는 만큼만 나갑니다.
 */
const MIN_CARDS = Number(process.env.MIN_CARDS || 12);

/** 이 글자 수 미만인 제목은 본문 포함 판정을 신뢰하지 않습니다 */
const MIN_MATCH_LEN = 2;

/**
 * 저자 이름 뒤에 문장이 시작됐음을 알리는 낱말.
 * **낱말 전체**로 비교합니다 — 접두 비교를 하면 "가와바타" 가 조사 `가` 로 잘립니다.
 */
const PARTICLES = new Set([
  '를', '을', '은', '는', '이', '가', '와', '과', '의', '에', '도', '만',
  '보다', '처럼', '추천', '같은', '등', '그리고', '또', '및',
]);

/**
 * 권차 표기를 떼어냅니다.
 *
 *   「혼불 1」「혼불 2」… → 「혼불」
 *   「토지 3권」          → 「토지」
 *   「해리 포터와 마법사의 돌 (1)」 → 「해리 포터와 마법사의 돌」
 *
 * 시리즈가 권별로 카드를 차지하면 목록이 한 작품으로 뒤덮입니다.
 * 실측에서 「혼불」 6권이 카드 6장을 먹었습니다.
 */
/**
 * 표시가 없는 맨 숫자를 권차로 인정할 상한.
 *
 * 왜 상한이 필요한가 (실측):
 *   「Fahrenheit 451」에서 " 451" 을 권차로 보고 떼면 「Fahrenheit」가 됩니다.
 *   451 은 제목의 일부입니다. 「Catch-22」도 같은 문제입니다.
 *   권차는 거의 20 이하이므로 그 위는 제목으로 봅니다.
 *   `권`·`Vol.`·괄호처럼 **표시가 붙은 경우**는 숫자가 커도 권차로 봅니다.
 */
const MAX_BARE_VOLUME = 20;

export function stripVolume(title) {
  let s = String(title ?? '');

  // ★ 표시가 붙은 권차 — 숫자 크기와 무관하게 떼어냅니다.
  //   영문 표기를 **먼저** 지웁니다. 순서를 잘못 두면 "Dune Vol. 2" 에서
  //   숫자만 먼저 사라져 "Dune Vol." 이 남습니다. 실측으로 잡았습니다.
  s = s
    .replace(/\s*(?:vol\.?|volume|book|part|no\.?|#)\s*\d{1,3}\s*$/i, '')
    .replace(/\s*[（(]\s*\d{1,3}\s*[)）]\s*$/, '')   // "… (1)"
    .replace(/\s*\d{1,3}\s*권\s*$/, '');             // "… 3권"

  // 표시 없는 맨 숫자 — 작은 수만 권차로 봅니다.
  const bare = s.match(/^(.*?)\s*[-–]?\s+(\d{1,3})\s*$/) || s.match(/^(.*?)[-–](\d{1,3})\s*$/);
  if (bare) {
    const n = Number(bare[2]);
    const base = bare[1].trim();
    // 남는 제목이 있고 숫자가 권차 범위이면 떼어냅니다.
    if (base && n >= 1 && n <= MAX_BARE_VOLUME) s = base;
  }

  return s.trim();
}

/**
 * 시리즈 권들을 한 권으로 접습니다.
 *
 * 같은 저자 + 권차를 뗀 제목이 같으면 하나로 봅니다.
 * 남기는 것은 **먼저 온 것**입니다 — merge 가 이미 점수순으로 정렬했으므로
 * 앞에 있는 쪽이 표지·평점이 더 갖춰진 레코드입니다.
 *
 * @param {object[]} books
 * @returns {{books: object[], collapsed: number}}
 */
export function collapseVolumes(books) {
  const seen = new Map();
  const out = [];
  let collapsed = 0;

  for (const b of books ?? []) {
    const base = normalizeForMatch(stripVolume(b?.title));
    const author = normalizeForMatch(b?.authors?.[0] ?? '');
    // 제목이 정규화 후 비면(기호만 있는 제목) 접지 않습니다.
    const key = base ? `${base}|${author}` : `id:${b?.id ?? Math.random()}`;

    if (seen.has(key)) {
      collapsed += 1;
      continue;
    }
    seen.set(key, true);
    out.push(b);
  }

  return { books: out, collapsed };
}

/**
 * 답변 텍스트에서 언급된 책을 찾습니다.
 *
 * 판정: 정규화한 답변 안에 정규화한 제목(권차 제거)이 들어 있는가.
 *   답변  "《태백산맥》 조정래 … 《혼불》 최명희"
 *   제목  "태백산맥 1"  → 권차 제거 "태백산맥" → 포함 ✓
 *
 * 정규화가 공백·기호를 모두 없애므로 《》, **, 「」 같은 장식이 방해하지 않습니다.
 *
 * @param {string} answer
 * @param {object[]} books
 * @returns {object[]} 언급된 순서가 아니라 원래(점수) 순서를 유지합니다
 */
export function matchMentioned(answer, books) {
  const hay = normalizeForMatch(answer);
  if (!hay) return [];

  return (books ?? []).filter((b) => {
    const t = normalizeForMatch(stripVolume(b?.title));
    if (t.length < MIN_MATCH_LEN) return false;
    return hay.includes(t);
  });
}

/**
 * 답변 본문에서 책 제목 후보를 뽑아냅니다.
 *
 * ★ 왜 필요한가
 *   LLM 이 답변에 적은 책이 **검색 결과에 없을 수 있습니다.**
 *   자기 지식으로 언급했거나, 검색은 다른 검색어로 했거나,
 *   도구가 그 책을 못 찾은 경우입니다. 그러면 카드가 없습니다.
 *   사용자는 "추천했는데 왜 카드가 없지" 로 받아들입니다.
 *
 *   그래서 답변에서 제목을 뽑아 **없는 것만 따로 조회**합니다(보충 조회).
 *
 * 인식하는 표기
 *   《제목》  『제목』  「제목」  【제목】   ← 프롬프트가 요구하는 표기. 가장 신뢰도 높음
 *   *제목*                                ← 영문 이탤릭
 *   **제목**                              ← 굵게 (아래 설명)
 *   줄머리의  제목 — 저자                  ← 표시 없이 쓴 경우
 *
 *   인용부호("…")는 쓰지 않습니다. 한국어 답변에서 강조·인용에 흔히 쓰여
 *   "정말 좋아요" 같은 문구가 제목으로 잡혔습니다.
 *
 * ★ **굵게** 를 나중에 받아들인 이유 (실측)
 *   처음에는 "굵게는 강조에도 쓰이니 제목으로 보지 않는다" 였습니다.
 *   그런데 프롬프트의 답변 형식 절이 "굵게 표시한 제목" 이라고 지시하고 있어서
 *   모델이 실제로 **제목** 으로 썼고, 그 책들은 보충 조회 대상에서 빠져
 *   카드가 하나도 붙지 않았습니다. (실측: 궁중요리 질문에서 「한국의 궁중음식」
 *   「조선왕조 궁중음식」이 답변에는 있는데 카드가 없었습니다)
 *
 *   프롬프트는 《》 를 쓰도록 고쳤지만, 모델이 지시를 흘릴 때를 대비해
 *   코드도 함께 받아들입니다. 비용이 비대칭입니다 —
 *     · 잘못 뽑으면: 조회 1회 낭비. pickBest 의 minTitle 0.7 이 걸러냅니다.
 *     · 못 뽑으면:   답변에 있는 책에 카드가 없습니다. ← 사용자가 겪은 문제
 *   그래서 받아들이는 쪽으로 기울입니다.
 *
 * 저자도 함께 잡습니다. 프롬프트가 `《제목》 — 저자` 형식을 쓰게 하고,
 * 저자를 함께 넘기면 조회 정확도가 크게 오릅니다
 * (같은 제목의 해설서·만화판을 걸러냅니다).
 *
 * @param {string} answer
 * @returns {{title: string, author: string}[]}
 */
export function extractTitles(answer) {
  const text = String(answer ?? '');
  if (!text.trim()) return [];

  /** @type {{title: string, author: string}[]} */
  const out = [];
  const seen = new Set();

  // 제목만 먼저 뽑습니다. 저자는 제목 **바로 뒤 구간**에서 따로 찾습니다.
  // 한 정규식으로 둘을 잡으려니 저자 자리에 문장이 딸려 들어왔습니다
  // (실측: 저자="를 좋아하신다면 이 세 작품을 강력히 추천드").
  // 신뢰도 높은 순서로 봅니다. 앞에서 잡힌 제목은 seen 에 들어가 중복되지 않습니다.
  //
  // trusted 는 "이 표기는 제목 전용인가" 입니다.
  //   《》 는 프롬프트가 제목에만 쓰라고 지시하므로 그대로 믿습니다.
  //   굵게·이탤릭·맨줄은 다른 용도로도 쓰이므로 추가 검사를 통과해야 합니다.
  const TITLE_PATTERNS = [
    // 겹낫표·겹화살괄호 — 프롬프트가 이 표기를 쓰게 합니다. 가장 신뢰도 높음.
    { re: /[《『「【]([^》』」】\n]{1,60})[》』」】]/g, trusted: true },
    // 굵게 — 프롬프트가 한동안 이 표기를 지시했고 모델이 아직 씁니다.
    { re: /\*\*([^*\n]{2,60})\*\*/g, trusted: false },
    // 영문 이탤릭. 굵게의 일부가 아닐 때만.
    { re: /(?<!\*)\*(?!\*)([^*\n]{2,60})\*(?!\*)/g, trusted: false },
    // 표시 없이 '제목 — 저자' 로 쓴 줄. 줄머리에서만, 구분자가 있을 때만 봅니다.
    // 목록 기호(- 1.)와 굵게 표시는 지나칩니다.
    //
    // 구분자를 lookahead 로 두는 이유: 저자는 authorAfter() 가 제목 **뒤 구간**을
    // 다시 읽어서 찾습니다. 여기서 ' — ' 까지 삼켜버리면 그 구간에 구분자가 없어
    // 저자를 못 찾습니다(실측: 저자가 전부 빈 문자열로 나왔습니다).
    //
    // ⚠️ 이 패턴은 오탐이 잘 납니다. 운영 로그에서 잡힌 실제 오탐:
    //      "직접 만들어보고 싶은지"  "역사와 문화로 읽고 싶은지"  "한국전쟁(6·25) 중심"
    //    모두 asked → got 0 으로 조회 예산만 낭비했습니다. 그래서 두 가지를 막습니다.
    //      1) 캡처 문자열에서 겹낫표·겹화살괄호를 제외 — 전에는
    //         "《The Adventures of Sherlock Holmes》(셜록 홈즈의 모험)" 이 통째로
    //         제목이 되어 같은 책을 두 번 조회했습니다.
    //      2) 아래 skipIfBracketed 로, 같은 줄에 《》 가 있으면 이 패턴을 쓰지 않음.
    //         《》 가 있으면 그게 제목이고 앞의 맨 글자는 이름표입니다.
    {
      re: /^[ \t]*(?:[-*•]\s+|\d{1,2}[.)]\s+)?\*{0,2}([^\n*—–《》『』「」【】]{2,60}?)\*{0,2}(?=\s+[—–]\s+\S)/gm,
      trusted: false,
      skipIfBracketed: true,
    },
  ];

  for (const { re, trusted, skipIfBracketed } of TITLE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const title = (m[1] ?? '').trim();
      const end = m.index + m[0].length;

      if (title.length < MIN_MATCH_LEN) continue;
      // 숫자·기호만 있는 것은 제목이 아닙니다
      if (!/[\p{L}]/u.test(title)) continue;

      // 같은 줄에 겹낫표 제목이 있으면 그쪽이 진짜입니다.
      // 이 맨 글자는 "한국전쟁(6·25) 중심 — 《제목》" 의 앞부분 같은 이름표입니다.
      if (skipIfBracketed && lineAt(text, m.index).match(/[《『「【]/)) continue;

      if (!trusted) {
        // 바로 뒤가 콜론이면 이름표입니다 — "**중요**: 장편입니다"
        // 제목을 인용할 때 콜론을 붙이지는 않습니다.
        if (/^\s*[:：]/.test(text.slice(end, end + 3))) continue;
        // 문장은 제목이 아닙니다 (강조에 쓰인 굵게를 걸러냅니다)
        if (looksLikeSentence(title)) continue;
      }

      const key = normalizeForMatch(stripVolume(title));
      if (!key || seen.has(key)) continue;
      seen.add(key);

      out.push({ title, author: authorAfter(text, end) });
    }
  }

  return out;
}

/** 주어진 위치가 속한 줄 하나를 돌려줍니다 (오탐 판정용) */
function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const nl = text.indexOf('\n', index);
  return text.slice(start, nl === -1 ? text.length : nl);
}

/**
 * 제목이 아니라 문장인지 판정합니다.
 *
 * **굵게** 와 줄머리 표기를 제목 후보로 받아들이면서 필요해졌습니다.
 * 모델은 "**정말 좋았어요**", "**이 책을 권합니다**" 처럼 강조에도 굵게를 씁니다.
 * 서술어 어미나 문장부호가 보이면 제목으로 보지 않습니다.
 *
 * 책 제목에도 어미가 들어갈 수 있어서(「살인자의 기억법」은 통과) 종결어미만 봅니다.
 */
function looksLikeSentence(s) {
  // 한국어 종결어미.
  //   '니다'  → 습니다·입니다·드립니다·합니다 를 한 번에 잡습니다
  //   'X요'   → 좋았어요·추천해요·그런가요 …
  // 「그리고 아무도 없었다」처럼 '다' 로 끝나는 제목은 일부러 넣지 않았습니다.
  // '요' 로 끝나는 제목(「…야근수당 주세요」)은 드물고, 그런 책도 《》 로
  // 감싸면 trusted 경로라 이 검사를 타지 않습니다.
  if (/(?:니다|[아어에여워]요|세요|지요|나요|까요|군요|네요)\s*$/.test(s)) {
    return true;
  }
  // 내포 의문·연결 어미. 제목에는 거의 없고 되묻는 문장에 흔합니다.
  // 실측 오탐: "직접 만들어보고 싶은지", "역사와 문화로 읽고 싶은지"
  if (/(?:는지|은지|을지|ㄹ지|인지|건지|던지|라면|다면|려면|거나|든지)\s*$/.test(s)) {
    return true;
  }
  // 문장 종결 부호가 중간에 있으면 문장입니다
  if (/[.!?]\s+\S/.test(s)) return true;
  // 낱말이 너무 많으면 제목보다 문장에 가깝습니다
  if (s.split(/\s+/).length > 12) return true;
  return false;
}

/**
 * 제목 바로 뒤에서 저자를 찾습니다.
 *
 * 프롬프트가 `《제목》 — 저자` 형식을 쓰게 합니다. 구분자(— – - by ( )가 있을 때만
 * 저자로 인정하고, 사람 이름처럼 보이지 않으면 버립니다.
 *
 * 저자를 함께 넘기면 조회 정확도가 크게 오릅니다 —
 * 같은 제목의 해설서·만화판을 걸러냅니다.
 */
function authorAfter(text, from) {
  // 굵게 표시가 제목을 감싸는 경우가 많아 닫는 ** 를 먼저 지나칩니다.
  let tail = text.slice(from, from + 90).replace(/^\*{1,2}/, '');

  // ★ 제목 뒤 괄호가 번역 제목인 경우를 건너뜁니다.
  //
  //   프롬프트는 원제 뒤에 번역 제목을 괄호로 붙이라고 지시합니다:
  //     《The Remains of the Day》(남아 있는 나날) — Kazuo Ishiguro
  //   그런데 괄호는 저자 구분자로도 쓰입니다(《제목》(저자)). 구분이 없으면
  //   번역 제목이 저자로 들어갑니다.
  //   실측: 「The Adventures of Sherlock Holmes」의 저자가 "셜록 홈즈" 로 잡혔습니다.
  //
  //   → 괄호 **뒤에 — 구분자가 더 있으면** 그 괄호는 번역 제목입니다. 건너뜁니다.
  //     구분자가 없으면 종전대로 괄호 안을 저자로 봅니다.
  const translated = tail.match(/^\s*[(（][^)）\n]{0,40}[)）]\s*(?=[—–]|-{1,2}\s|by\s)/i);
  if (translated) tail = tail.slice(translated[0].length);

  const m = tail.match(/^\s*(?:[—–]|-{1,2}|by\s+|[(（])\s*([^\n,.·()（）—–]{1,40})/i);
  if (!m) return '';

  let name = m[1].trim().replace(/\s*(?:지음|저|글|옮김|엮음)\s*$/, '').trim();

  // ★ 이름만 남깁니다.
  //
  //   영문 답변에서 "by Gillian Flynn is a tight thriller" 처럼 문장이 이어집니다.
  //   한글은 조사 규칙으로 걸러지지만 영문에는 조사가 없습니다.
  //   사람 이름은 낱말 1~4개이므로 그 뒤는 버립니다.
  //   그리고 소문자로 시작하는 낱말(is, for, also…)이 나오면 거기서 끊습니다.
  const words = name.split(/\s+/);
  const kept = [];
  for (const w of words) {
    if (/^[\uac00-\ud7a3]/.test(w)) {
      // ★ 낱말 **전체**로 판정합니다.
      //   처음에는 조사로 **시작**하는지 봤는데, "가와바타 야스나리" 의 "가와바타" 가
      //   조사 `가` 로 시작한다고 잘렸습니다. 실측으로 잡았습니다.
      if (PARTICLES.has(w)) break;

      // 이름에 조사가 붙어 있으면 떼고 거기서 끊습니다 ("최명희를 추천합니다").
      // 3글자 이상일 때만 뗍니다 — "정은" 같은 두 글자 이름을 "정" 으로 만들면 안 됩니다.
      const stripped = w.length >= 3 ? w.replace(/[를을은는이가와과의에도]$/, '') : w;
      if (stripped !== w) {
        kept.push(stripped);
        break;
      }
      kept.push(w);
      continue;
    }
    // 영문 — 대문자로 시작하는 낱말만 이름으로 봅니다
    if (/^[A-Z]/.test(w)) { kept.push(w); continue; }
    break;
  }
  // 사람 이름은 낱말 1~4개입니다. 그 뒤는 버립니다.
  name = kept.slice(0, 4).join(' ').trim();

  // 문장 조각을 걸러냅니다. 서술어가 있으면 사람 이름이 아닙니다.
  //
  // ⚠️ 예전에 여기에 "조사로 끝나는 짧은 조각 제외" 규칙도 있었는데,
  //    아래 낱말 단위 처리와 겹쳐서 「정은」 같은 두 글자 이름을 지웠습니다.
  //    조사 처리는 낱말 단위 쪽 하나로만 합니다.
  if (!name || name.length > 40) return '';
  if (/(?:습니다|해요|이다|하다|라고|에서|으로|까지|부터|입니다)/.test(name)) return '';
  if (!/[\p{L}]/u.test(name)) return '';

  return name;
}

/**
 * 답변에 나왔지만 카드가 없는 제목을 찾습니다.
 *
 * @param {string} answer
 * @param {object[]} haveBooks  이미 카드가 있는 책
 * @returns {{title: string, author: string}[]}
 */
export function missingTitles(answer, haveBooks) {
  const have = new Set(
    (haveBooks ?? []).map((b) => normalizeForMatch(stripVolume(b?.title))).filter(Boolean),
  );

  return extractTitles(answer).filter((t) => {
    const k = normalizeForMatch(stripVolume(t.title));
    if (!k) return false;
    // 이미 있는 카드의 제목을 포함하거나 포함되면 같은 책으로 봅니다
    for (const h of have) {
      if (h === k || h.includes(k) || k.includes(h)) return false;
    }
    return true;
  });
}

/**
 * 카드로 내보낼 책을 결정합니다.
 *
 * 1) 시리즈 권을 접습니다
 * 2) 답변에서 언급된 책을 먼저 담습니다 (언급된 책은 **반드시** 카드가 있어야 합니다)
 * 3) 그 수가 MIN_CARDS 보다 적으면 남은 후보로 채웁니다
 * 4) 하나도 못 맞추면 상위 몇 권으로 물러납니다
 *
 * ★ 3번을 넣은 이유 (실측)
 *   검색은 18~40권을 물어오는데 답변이 5~9권만 언급해서 카드도 5~9장이었습니다.
 *   로그: total 40 → presented 8,  total 25 → presented 5.
 *   사용자는 "찾은 건 많은데 왜 이만큼만 보여주나" 로 받아들입니다.
 *   언급된 책을 앞에 두고, 뒤를 남은 후보로 채우면 둘 다 만족합니다 —
 *   답변에 나온 책은 전부 카드가 있고, 화면도 비어 보이지 않습니다.
 *
 * ★ 4번도 중요합니다.
 *   카드가 0장이면 사용자는 "검색이 안 됐다" 고 받아들입니다.
 *   답변이 "찾지 못했습니다" 인 경우도 있고, LLM 이 제목을 번역해 적어
 *   매칭에 실패하는 경우도 있습니다. 그때 빈 화면을 주는 것보다
 *   점수 상위 몇 권을 보여주는 편이 낫습니다.
 *
 * @param {{answer: string, books: object[], limit?: number, minCards?: number}} p
 * @returns {{books: object[], reason: 'mentioned'|'mentioned+filled'|'fallback'|'empty',
 *            collapsed: number, dropped: number, mentioned: number, filled: number}}
 */
export function selectForCards({ answer, books, limit = FALLBACK_LIMIT, minCards = MIN_CARDS }) {
  const all = books ?? [];
  if (!all.length) {
    return { books: [], reason: 'empty', collapsed: 0, dropped: 0, mentioned: 0, filled: 0 };
  }

  const { books: unique, collapsed } = collapseVolumes(all);
  const mentioned = matchMentioned(answer, unique);

  if (mentioned.length) {
    // 언급된 책이 먼저, 그다음 남은 후보로 최소 개수까지 채웁니다.
    // 순서를 지키는 이유: 답변을 읽으며 위에서부터 짚어볼 수 있어야 합니다.
    const picked = [...mentioned];
    if (picked.length < minCards) {
      const inPicked = new Set(picked.map((b) => b?.id ?? b?.title));
      for (const b of unique) {
        if (picked.length >= minCards) break;
        if (inPicked.has(b?.id ?? b?.title)) continue;
        // ★ 채우는 책에만 학술서 검사를 적용합니다.
        //
        //   검색 결과에는 「한국 현대 소설 연구」처럼 "그 장르를 연구한 책" 이
        //   섞여 들어옵니다. LLM 이 그걸 추천하지 않은 건 옳은 판단이었는데,
        //   빈자리를 메운다고 다시 넣으면 카드 선별을 만든 이유가 사라집니다.
        //   언급된 책은 이 검사를 타지 않습니다 — 사용자가 연구서를 물었고
        //   LLM 이 연구서를 골랐다면 그건 정답입니다.
        if (looksAcademic(b)) continue;
        picked.push(b);
      }
    }
    const filled = picked.length - mentioned.length;
    return {
      books: picked,
      reason: filled ? 'mentioned+filled' : 'mentioned',
      collapsed,
      dropped: unique.length - picked.length,
      mentioned: mentioned.length,
      filled,
    };
  }

  // 답변에서 아무 제목도 못 찾았습니다.
  const fallback = unique.slice(0, Math.max(limit, minCards));
  return {
    books: fallback,
    reason: 'fallback',
    collapsed,
    dropped: unique.length - fallback.length,
    mentioned: 0,
    filled: fallback.length,
  };
}

/** 로그용 요약 (운영에서 선별이 잘 되는지 보려고) */
export function logSelection(sel, total) {
  log.info('카드 선별', {
    total,
    collapsed: sel.collapsed,
    presented: sel.books.length,
    // mentioned = 답변이 실제로 언급한 수, filled = 최소 개수를 맞추려 채운 수
    // filled 가 늘 크면 답변이 후보를 충분히 안 쓰고 있다는 뜻입니다.
    mentioned: sel.mentioned,
    filled: sel.filled,
    dropped: sel.dropped,
    reason: sel.reason,
  });
}
