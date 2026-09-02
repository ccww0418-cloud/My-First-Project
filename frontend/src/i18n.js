/**
 * 다국어 (i18n)
 *
 * 왜 라이브러리를 쓰지 않는가:
 *   문자열이 60개 수준이고 복수형·성별 변화 같은 복잡한 규칙이 없습니다.
 *   i18next + react-i18next 는 gzip 후 약 20KB인데, 현재 번들 전체가 53KB입니다.
 *   기능 대비 비용이 맞지 않아 사전 + useSyncExternalStore 로 직접 구현합니다.
 *   문자열이 200개를 넘거나 복수형 규칙이 필요해지면 그때 i18next 로 옮기세요.
 *
 * 기본 언어는 영어입니다.
 *   navigator.language 를 자동으로 따르지 않습니다. 접속 지역과 무관하게
 *   첫 화면을 영어로 통일하려는 의도적 선택입니다. 사용자가 토글로 바꾸면
 *   localStorage 에 기억합니다.
 *
 * 중요: UI 언어는 챗봇의 **답변 언어와 별개**입니다.
 *   답변 언어는 Bedrock 모델이 사용자가 입력한 언어를 보고 스스로 맞춥니다.
 *   즉 UI가 영어여도 한국어로 질문하면 한국어로 답합니다.
 */

import { useSyncExternalStore } from 'react';

export const DEFAULT_LANG = 'en';
export const SUPPORTED_LANGS = ['en', 'ko'];

/** 언어 선택 UI에 쓸 표시 이름 (각 언어의 자국어 표기) */
export const LANG_NAMES = { en: 'English', ko: '한국어' };

const STORAGE_KEY = 'bookbot.lang';

// ────────────────────────────────────────────────────────────────
// 사전
// ────────────────────────────────────────────────────────────────
// 규칙: 키는 영어 소문자 + 점. 변수는 {name} 형태.
// en 을 기준으로 삼고, ko 에 키가 없으면 en 으로 자동 폴백합니다.

const EN = {
  // 헤더 — 라틴어 모토를 앞세운 도록 캡션 형식
  // 대문자 + 넓은 자간으로 조판되므로 짧아야 합니다.
  // 길면 3줄로 늘어져 머리글 균형이 무너집니다.
  'app.tagline': 'Liber tibi electus · a book chosen for you',
  'app.newChat': 'New',
  'theme.toDark': 'Switch to dark theme',
  'theme.toLight': 'Switch to light theme',
  'theme.dark': 'Nuit',
  'theme.light': 'Jour',
  'lang.label': 'Change language',

  // 빈 화면
  'empty.title': 'What shall we read?',
  'empty.desc1': 'A title is not required. Describe a mood, a circumstance, an author you once loved —',
  'empty.desc2': 'four catalogues will be consulted, and only books that truly exist will be offered.',

  // 통계 푸터
  'stats.line': '{seconds}s · tokens in {in} / out {out}',
  'stats.books': ' · {count} books',

  // 읽을 목록
  'saved.button': 'Reading list ({count})',
  'saved.save': 'Add to list',
  'saved.saved': 'On your list',
  'saved.remove': 'Remove',
  'saved.full': 'Your list is full ({max} books).',
  'saved.title': 'Reading list',
  'saved.count': '{count} of {max} books kept in this browser',
  'saved.emptyHint': 'Nothing kept yet',
  'saved.emptyBody':
    'Books you add will wait here. They are kept in this browser only — no account, and nothing sent anywhere.',
  'saved.listAria': '{count} saved books',
  'saved.clear': 'Empty the list',
  'saved.clearConfirm': 'Remove all {count} books from your reading list?',
  'saved.close': 'Back to the conversation',
  'saved.notPersistent':
    'This browser is blocking local storage, so the list will disappear when you reload. Private browsing usually causes this.',

  // 답변 평가
  'fb.ask': 'Was this helpful?',
  'fb.up': 'Yes',
  'fb.down': 'Not really',
  'fb.thanksUp': 'Thank you — noted.',
  'fb.thanksDown': 'Thank you — noted. Tell me what to change and I will look again.',
  'fb.failed': 'Could not record that. It does not affect our conversation.',
  'fb.failedRetry': 'That did not go through. Try again?',

  // 제안 칩
  'chips.label': 'You might ask',

  // 대화
  // 대기 표시. 진행 이벤트가 없으므로(버퍼 응답) 서버 예산상 그 시점에
  // 실제로 일어나는 일만 적습니다. 없는 진행 상황을 지어내지 않습니다.
  'wait.preparing': 'Getting ready…',
  'wait.searching': 'Looking through libraries and bookshops…',
  'wait.writing': 'Choosing from what I found…',
  'wait.almost': 'Almost there — thanks for waiting.',
  'wait.elapsed': '{seconds}s',
  'chat.cardsAria': '{count} recommended books',
  'chat.errorTitle': 'Something went wrong',
  'chat.connErrorTitle': 'Connection error',
  'chat.writing': 'Writing a reply',

  // 말풍선 (스크린리더용 화자 표기)
  'msg.user': 'Your message: ',
  'msg.bot': 'The reply: ',

  // 진행 표시
  'tools.aria': 'Search progress',
  'tools.count': '{count} books',
  'tools.noResult': 'No results',
  'tools.seconds': ' · {seconds}s',

  // 입력창
  'composer.placeholder': 'What are you looking for? Describing your mood or situation helps a lot.',
  'composer.aria': 'Message input',
  'composer.stop': 'Stop',
  'composer.send': 'Send',
  'composer.sendHint': ' (you can also press Enter)',
  'composer.hint': 'Enter to send · Shift+Enter for a new line',
  'composer.remaining': '{count} characters left',

  // 책 카드
  'card.andOthers': ' and {count} more',
  'card.unknownAuthor': 'author unknown',
  'card.noAuthor': 'No author information',
  'card.coverAlt': 'Cover of {title}',
  'card.pages': '{count} pages',
  // 라틴 문자 상표(Google Books 등)는 그대로 두지만 이 둘은 한글 이름이라
  // 영어 화면에서 읽을 수 없습니다. 영어권 공식 표기를 씁니다.
  'card.srcAladin': 'Aladin',
  'card.srcNlk': 'National Library of Korea',
  'card.series': 'Series: {series}',
  'card.seriesPos': ' #{position}',
  'card.ratingTitle': '{source} rating',
  'card.ratings': '{count} ratings',
  'card.free': 'Free full text',
  'card.audiobook': 'Audiobook',
  'card.verifiedTitle': 'Cross-checked in {sources}',
  'card.verified': '{count} catalogues',
  'card.genres': 'Genres',
  'card.moods': 'Mood',
  'card.warnings': 'Content warnings ({count})',
  'card.freeAt': 'Free on {source}',
  'card.readWeb': 'Read online',
  'card.read': 'Read',
  'card.newWindow': ' (opens in a new window)',

  // HTTP 오류
  'err.noStream': 'This browser does not support streaming responses.',
  'err.403': 'Access denied. Check the CloudFront and Lambda permission settings.',
  'err.404': 'API path not found. Check the /api/* behavior in CloudFront.',
  'err.413': 'Your message is too long.',
  'err.429': 'Too many requests. Please try again in a moment.',
  'err.5xx': 'The server is taking too long to respond. Please try again shortly.',
  'err.default': 'The request failed (HTTP {status}).',
  'err.unknown': 'An unknown error occurred.',

  // 진단 (빈 응답 등)
  'diag.events': '{count} events received',
  'diag.firstByte': 'first byte {ms}ms',
  'diag.noResponse': 'no response',
  'diag.total': '{seconds}s total',
  'diag.doneYes': 'done received',
  'diag.doneNo': 'done missing',
  'diag.nothing':
    'No response at all from the server. ({diag})\nThis may be the /api/* behavior in CloudFront, or a Lambda execution error. Check the CloudWatch logs.',
  'diag.noText':
    'Connected, but no answer text arrived. ({diag})\nA Bedrock call most likely failed. Look for error entries in the CloudWatch logs.',
  'diag.timeout':
    'Stopped after waiting more than 100 seconds.\nThe server finishes its answer within 26 seconds, so seeing this means the request never reached it. Check the /api/* behavior in CloudFront, or the CloudWatch logs.',
  'diag.aborted': '(request cancelled)',
};

const KO = {
  'app.tagline': 'Liber tibi electus · 당신을 위해 고른 한 권',
  'app.newChat': '새 대화',
  'theme.toDark': '어두운 테마로 전환',
  'theme.toLight': '밝은 테마로 전환',
  'theme.dark': 'Nuit',
  'theme.light': 'Jour',
  'lang.label': '언어 변경',

  'empty.title': '무엇을 읽으시겠습니까',
  'empty.desc1': '제목은 필요하지 않습니다. 기분, 상황, 한때 좋아했던 작가를 말씀해 주시면',
  'empty.desc2': '네 곳의 도서 목록을 살펴 실제로 존재하는 책만 골라 드립니다.',

  'stats.line': '응답 {seconds}초 · 토큰 in {in} / out {out}',
  'stats.books': ' · 도서 {count}권',

  'saved.button': '읽을 목록 ({count})',
  'saved.save': '목록에 담기',
  'saved.saved': '목록에 있음',
  'saved.remove': '빼기',
  'saved.full': '목록이 꽉 찼습니다 ({max}권).',
  'saved.title': '읽을 목록',
  'saved.count': '{max}권 중 {count}권 — 이 브라우저에만 보관됩니다',
  'saved.emptyHint': '아직 담은 책이 없습니다',
  'saved.emptyBody':
    '담아둔 책이 여기서 기다립니다. 이 브라우저에만 보관되며 계정도 필요 없고 어디로도 전송되지 않습니다.',
  'saved.listAria': '담아둔 책 {count}권',
  'saved.clear': '목록 비우기',
  'saved.clearConfirm': '읽을 목록에서 {count}권을 모두 지울까요?',
  'saved.close': '대화로 돌아가기',
  'saved.notPersistent':
    '이 브라우저가 저장을 막고 있어 새로고침하면 목록이 사라집니다. 시크릿 모드일 때 주로 이렇습니다.',

  'fb.ask': '도움이 되었나요?',
  'fb.up': '좋았어요',
  'fb.down': '아니에요',
  'fb.thanksUp': '기록했습니다. 감사합니다.',
  'fb.thanksDown': '기록했습니다. 어떤 점을 바꿀지 말씀해 주시면 다시 찾아보겠습니다.',
  'fb.failed': '평가를 기록하지 못했습니다. 대화에는 영향이 없습니다.',
  'fb.failedRetry': '전송되지 않았어요. 다시 눌러보시겠어요?',

  'chips.label': '이렇게 물어보실 수 있습니다',

  'wait.preparing': '준비하고 있어요…',
  'wait.searching': '여러 도서관과 서점을 찾아보고 있어요…',
  'wait.writing': '찾은 책 중에서 골라 정리하고 있어요…',
  'wait.almost': '거의 다 됐어요. 조금만 기다려 주세요.',
  'wait.elapsed': '{seconds}초',
  'chat.cardsAria': '추천 도서 {count}권',
  'chat.errorTitle': '문제가 발생했습니다',
  'chat.connErrorTitle': '연결 오류',
  'chat.writing': '답변을 작성하고 있습니다',

  'msg.user': '나의 메시지: ',
  'msg.bot': '답변: ',

  'tools.aria': '검색 진행 상황',
  'tools.count': '{count}권',
  'tools.noResult': '결과 없음',
  'tools.seconds': ' · {seconds}초',

  'composer.placeholder': '어떤 책을 찾으세요? 기분이나 상황을 말해주면 더 잘 찾아드려요.',
  'composer.aria': '메시지 입력',
  'composer.stop': '중단',
  'composer.send': '전송',
  'composer.sendHint': ' (Enter 키로도 전송 가능)',
  'composer.hint': 'Enter 전송 · Shift+Enter 줄바꿈',
  'composer.remaining': '{count}자 남음',

  'card.andOthers': ' 외 {count}명',
  'card.unknownAuthor': '저자 미상',
  'card.noAuthor': '저자 정보 없음',
  'card.coverAlt': '《{title}》 표지',
  'card.pages': '{count}쪽',
  'card.srcAladin': '알라딘',
  'card.srcNlk': '국립중앙도서관',
  'card.series': '시리즈: {series}',
  'card.seriesPos': ' {position}권',
  'card.ratingTitle': '{source} 평점',
  'card.ratings': '{count}명',
  'card.free': '무료 전문',
  'card.audiobook': '오디오북',
  'card.verifiedTitle': '{sources}에서 교차 확인',
  'card.verified': '{count}개 목록 확인',
  'card.genres': '장르',
  'card.moods': '분위기',
  'card.warnings': '내용 주의 {count}건',
  'card.freeAt': '{source}에서 무료',
  'card.readWeb': '웹으로 읽기',
  'card.read': '읽기',
  'card.newWindow': ' (새 창에서 열림)',

  'err.noStream': '이 브라우저는 스트리밍 응답을 지원하지 않습니다.',
  'err.403': '접근이 거부되었습니다. CloudFront와 Lambda 권한 설정을 확인하세요.',
  'err.404': 'API 경로를 찾을 수 없습니다. CloudFront의 /api/* 동작 설정을 확인하세요.',
  'err.413': '메시지가 너무 깁니다.',
  'err.429': '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  'err.5xx': '서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.',
  'err.default': '요청이 실패했습니다 (HTTP {status}).',
  'err.unknown': '알 수 없는 오류가 발생했습니다.',

  'diag.events': '이벤트 {count}개 수신',
  'diag.firstByte': '첫 응답 {ms}ms',
  'diag.noResponse': '응답 없음',
  'diag.total': '총 {seconds}초',
  'diag.doneYes': 'done 수신',
  'diag.doneNo': 'done 미수신',
  'diag.nothing':
    '서버로부터 아무 응답도 받지 못했습니다. ({diag})\nCloudFront의 /api/* 동작 설정 또는 Lambda 실행 오류일 수 있습니다. CloudWatch 로그를 확인하세요.',
  'diag.noText':
    '연결은 됐지만 답변 텍스트가 오지 않았습니다. ({diag})\nBedrock 호출이 실패했을 가능성이 높습니다. CloudWatch 로그의 error 항목을 확인하세요.',
  // 실제로 가장 먼저 걸리는 한계를 적습니다. 예전에는 "Lambda 90초 / CloudFront 60초"
  // 라고 안내했는데, 그건 함수 URL 시절 값입니다. 지금 경로에서는 API Gateway 통합
  // 타임아웃 30초가 먼저 걸리고, 그 전에 서버가 스스로 26초에 답변을 마무리합니다.
  'diag.timeout':
    '응답 시간이 100초를 넘어 중단했습니다.\n서버는 26초 안에 답변을 마무리하도록 되어 있으니, 이 오류가 보이면 서버에 닿지 못한 것입니다. CloudFront의 /api/* 동작 설정이나 CloudWatch 로그를 확인하세요.',
  'diag.aborted': '(요청을 중단했습니다)',
};

const DICT = { en: EN, ko: KO };

// ────────────────────────────────────────────────────────────────
// 스토어 (Provider 없이 전역 구독)
// ────────────────────────────────────────────────────────────────

function readStored() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (SUPPORTED_LANGS.includes(saved)) return saved;
  } catch {
    /* 시크릿 모드 등에서 접근 불가 */
  }
  return DEFAULT_LANG;
}

let current = readStored();
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

export function getLang() {
  return current;
}

export function setLang(lang) {
  if (!SUPPORTED_LANGS.includes(lang) || lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 무시 */
  }
  syncDocumentLang();
  emit();
}

/**
 * <html lang> 을 실제 UI 언어와 맞춥니다.
 * 이걸 빼먹으면 스크린리더가 영어 문장을 한국어 음성으로 읽습니다(WCAG 3.1.1 위반).
 */
export function syncDocumentLang() {
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ────────────────────────────────────────────────────────────────
// 번역
// ────────────────────────────────────────────────────────────────

/**
 * @param {string} key
 * @param {Record<string, string|number>} [vars]  {name} 자리에 넣을 값
 * @param {string} [lang]
 */
export function translate(key, vars, lang = current) {
  const table = DICT[lang] ?? EN;
  // 번역 누락 시 영어로 폴백. 영어에도 없으면 키를 그대로 보여줘서
  // 개발 중에 빠진 키가 눈에 띄게 합니다.
  const raw = table[key] ?? EN[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined ? m : String(vars[name])));
}

/**
 * 컴포넌트에서 쓰는 훅. 언어가 바뀌면 자동으로 다시 렌더됩니다.
 * @returns {{ lang: string, setLang: (l:string)=>void, t: (k:string, v?:object)=>string }}
 */
export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getLang, () => DEFAULT_LANG);
  return {
    lang,
    setLang,
    t: (key, vars) => translate(key, vars, lang),
  };
}

// ────────────────────────────────────────────────────────────────
// 로케일 인식 숫자 포맷
// ────────────────────────────────────────────────────────────────

/**
 * 평점 참여자 수 같은 큰 수를 짧게. Intl 을 쓰는 이유:
 *   기존 코드는 "1.2천명"으로 한국식 만 단위를 하드코딩했습니다.
 *   영어권은 1.2K, 프랑스어권은 1,2 k 로 소수점 구분자까지 다릅니다.
 *   Intl.NumberFormat 이 이걸 로케일별로 처리합니다.
 */
export function formatCompact(n, lang = current) {
  const num = Number(n) || 0;
  try {
    return new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(num);
  } catch {
    return String(num);
  }
}

/** 소수 1자리 — 유럽 로케일은 소수점이 쉼표입니다(1,4초). */
export function formatDecimal(n, lang = current, digits = 1) {
  const num = Number(n) || 0;
  try {
    return new Intl.NumberFormat(lang, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(num);
  } catch {
    return num.toFixed(digits);
  }
}

/** 정수 — 천단위 구분자를 로케일에 맞게 (1,234 / 1 234) */
export function formatInt(n, lang = current) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  try {
    return new Intl.NumberFormat(lang).format(num);
  } catch {
    return String(num);
  }
}
