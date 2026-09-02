/**
 * 렌더 검수 (일회성 도구)
 *
 * 브라우저 없이 실제 컴포넌트를 HTML 로 뽑아서
 * 시나리오별로 화면에 무엇이 나오는지 확인합니다.
 *
 *   npx vite build --ssr scripts/render-check.jsx --outDir .render --emptyOutDir
 *   node .render/render-check.js
 *
 * localStorage 가 없는 환경이므로 저장 기능은 메모리 폴백으로 동작합니다.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatWindow from '../src/components/ChatWindow.jsx';
import { stageAt } from '../src/components/Thinking.jsx';
import SavedPanel from '../src/components/SavedPanel.jsx';
import BookCard from '../src/components/BookCard.jsx';
import Feedback from '../src/components/Feedback.jsx';

const book = (over = {}) => ({
  id: 'gb:1',
  title: '소년이 온다',
  authors: ['한강'],
  year: 2014,
  pageCount: 216,
  coverUrl: 'https://image.aladin.co.kr/x.jpg',
  isbn13: ['9788936434120'],
  rating: { value: 4.5, count: 1234, source: 'Hardcover' },
  moods: ['reflective', 'emotional'],
  categories: ['소설/시/희곡', '한국소설'],
  contentWarnings: ['violence'],
  sources: ['aladin', 'googleBooks'],
  links: { aladin: 'https://aladin.co.kr/x', googleBooks: 'https://books.google.com/x' },
  ...over,
});

const scenes = {
  '1. 답변 + 책카드 + 평가버튼': (
    <ChatWindow
      turns={[
        { id: 'u1', role: 'user', text: '위로되는 한국 소설 추천해줘' },
        {
          id: 'a1',
          role: 'assistant',
          text: '한강의 소년이 온다를 권합니다.',
          books: [book()],
          activities: [{ id: 'x', name: 'search_books', label: '도서 검색', query: '한국 소설', done: true, count: 5, ms: 820 }],
          notices: [],
          streaming: false,
          error: null,
          logRef: 'LOG#2026-08-31::2026-08-31T07:56:00.725Z#a1b2c3d4',
        },
      ]}
      streaming={false}
      error=""
    />
  ),
  '2. 스트리밍 중 (평가버튼 없어야 함)': (
    <ChatWindow
      turns={[
        { id: 'u2', role: 'user', text: '질문' },
        { id: 'a2', role: 'assistant', text: '쓰는 중', books: [], activities: [], notices: [], streaming: true, error: null, logRef: null },
      ]}
      streaming
      error=""
    />
  ),
  '3. 오류 턴 (평가버튼 없어야 함)': (
    <ChatWindow
      turns={[
        { id: 'u3', role: 'user', text: '질문' },
        { id: 'a3', role: 'assistant', text: '', books: [], activities: [], notices: [], streaming: false, error: '시간이 초과되었습니다', logRef: 'LOG#2026-08-31::2026-08-31T07:56:00.725Z#a1b2c3d4' },
      ]}
      streaming={false}
      error=""
    />
  ),
  '4. 정책 차단 (logRef 없음 → 평가버튼 없어야 함)': (
    <ChatWindow
      turns={[
        { id: 'u4', role: 'user', text: '차단되는 질문' },
        { id: 'a4', role: 'assistant', text: '도서 추천에 대해서만 도와드릴 수 있습니다.', books: [], activities: [], notices: [], streaming: false, error: null, logRef: null },
      ]}
      streaming={false}
      error=""
    />
  ),
  // ★ 실제로 사용자가 신고한 답변 원문입니다.
  //   '##' 이 굵은 제목이 아니라 글자로 그대로 보였습니다.
  //   프롬프트(prompt.mjs)는 '## 헤딩을 써라'고 지시하는데 파서에
  //   헤딩 분기가 없었던 것이 원인입니다. 이 시나리오가 그걸 잡습니다.
  '10. 마크다운 — 헤딩·수평선·번호목록·표·링크': (
    <ChatWindow
      turns={[
        { id: 'u10', role: 'user', text: '한국 궁중요리 책 추천해줘' },
        {
          id: 'a10',
          role: 'assistant',
          text: [
            '한국 궁중요리 관련 책을 찾아볼게요!',
            '',
            '---',
            '',
            '## 확인된 책',
            '',
            '**수라간 요리 비기(秘記)** — 김은영 (2006)',
            '어렵게 느껴지는 궁중요리를 일반 가정에서도 따라 할 수 있도록 재해석한 실용 레시피북입니다.',
            '',
            '### 함께 보면 좋은 책',
            '',
            '1. **한국의 궁중음식** — 한복려',
            '2. **조선왕조 궁중음식** — 황혜성',
            '',
            '- 불릿 항목 하나',
            '- 불릿 항목 둘',
            '',
            '| 조건 | 만족 |',
            '|---|---|',
            '| 궁중요리 | 예 |',
            '',
            '> 이 두 분은 궁중음식의 계보를 직접 이은 전문가입니다.',
            '',
            '자세히는 [궁중음식연구원](https://www.food.co.kr) 에서 볼 수 있어요.',
            '위험한 링크 [클릭](javascript:alert(1)) 는 앵커가 되면 안 됩니다.',
          ].join('\n'),
          books: [],
          activities: [],
          notices: [],
          streaming: false,
          error: null,
          logRef: null,
        },
      ]}
      streaming={false}
      error=""
    />
  ),
  // 답변이 오기 전 대기 구간. 버퍼 응답이라 10~25초 머무는 화면입니다.
  // SSR 에서는 useEffect 가 돌지 않으므로 경과 0초 = 첫 단계가 나와야 합니다.
  '11. 대기 중 (답변·진행표시 둘 다 없음)': (
    <ChatWindow
      turns={[
        { id: 'u11', role: 'user', text: '위로되는 소설 추천해줘' },
        {
          id: 'a11',
          role: 'assistant',
          text: '',
          books: [],
          activities: [],
          notices: [],
          streaming: true,
          error: null,
          logRef: null,
        },
      ]}
      streaming
      error=""
    />
  ),
  '5. 읽을 목록 (비어 있음)': <SavedPanel onClose={() => {}} />,
  '6. 카드 — 목록 안 (빼기 버튼)': <BookCard book={{ ...book(), key: 'i:9788936434120' }} inList />,
  '7. 카드 — 축소 저장된 형태 (설명·무드·분류 없음)': (
    <BookCard
      book={{ key: 'i:9788936434120', id: 'gb:1', title: '소년이 온다', subtitle: '', authors: ['한강'], year: 2014, pageCount: null, coverUrl: null, isbn13: ['9788936434120'], rating: null, links: {}, freeEbook: null, sources: ['aladin'], savedAt: '2026-08-31T00:00:00.000Z' }}
      inList
    />
  ),
  '8. 평가 컴포넌트 단독': <Feedback logRef="LOG#2026-08-31::2026-08-31T07:56:00.725Z#a1b2c3d4" />,
  '9. 평가 — logRef 없음 (아무것도 렌더 안 해야 함)': <Feedback logRef={null} />,
};

let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail += 1;
  console.log(`    ${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
};

const html = {};
for (const [name, el] of Object.entries(scenes)) {
  let out;
  try {
    out = renderToStaticMarkup(el);
  } catch (e) {
    console.log(`\n  ${name}\n    ✗ 렌더 예외: ${e.message}`);
    fail += 1;
    continue;
  }
  html[name] = out;
  console.log(`\n  ${name}  (${out.length}자)`);
}

console.log('\n■ 시나리오 검증');
const s1 = html['1. 답변 + 책카드 + 평가버튼'] ?? '';
check('답변 텍스트 표시', s1.includes('소년이 온다를 권합니다'));
check('책 카드 렌더', s1.includes('class="card"'));
check('평가 버튼 표시', s1.includes('fb__btn'));
check('저장 버튼 표시', s1.includes('card__save'));
check('알라딘 링크가 첫 외부링크', s1.indexOf('aladin.co.kr') < s1.indexOf('books.google.com'));
check('외부링크 noopener', (s1.match(/rel="noopener noreferrer"/g) ?? []).length >= 2);
check('평가가 카드보다 아래', s1.lastIndexOf('fb__btn') > s1.lastIndexOf('class="card"'));

const s2 = html['2. 스트리밍 중 (평가버튼 없어야 함)'] ?? '';
check('스트리밍 중 평가 없음', !s2.includes('fb__btn'));

const s3 = html['3. 오류 턴 (평가버튼 없어야 함)'] ?? '';
check('오류 턴 평가 없음', !s3.includes('fb__btn'));
check('오류 알림 role=alert', s3.includes('role="alert"'));

const s4 = html['4. 정책 차단 (logRef 없음 → 평가버튼 없어야 함)'] ?? '';
check('차단 답변 평가 없음', !s4.includes('fb__btn'));

const s5 = html['5. 읽을 목록 (비어 있음)'] ?? '';
check('빈 목록 안내 표시', s5.includes('saved__empty'));
check('빈 목록에 비우기 버튼 없음', !s5.includes('saved.clear') && !s5.includes('목록 비우기'));
check('닫기 버튼 있음', s5.includes('saved__btn--close'));

const s6 = html['6. 카드 — 목록 안 (빼기 버튼)'] ?? '';
check('목록 안에서는 빼기 버튼', s6.includes('card__save--remove'));
check('목록 안에서는 저장 토글 없음', !s6.includes('aria-pressed'));

const s7 = html['7. 카드 — 축소 저장된 형태 (설명·무드·분류 없음)'] ?? '';
check('축소 데이터로도 예외 없이 렌더', s7.includes('class="card"'));
check('표지 없으면 대체 표시', s7.includes('card__cover-fallback'));
check('평점 없으면 배지 생략', !s7.includes('badge--rating'));

const s8 = html['8. 평가 컴포넌트 단독'] ?? '';
check('평가 질문 문구 표시', s8.includes('fb__ask'));
check('버튼 2개', (s8.match(/fb__btn/g) ?? []).length === 2);

check('logRef 없으면 빈 렌더', (html['9. 평가 — logRef 없음 (아무것도 렌더 안 해야 함)'] ?? 'x') === '');

// ── 마크다운 렌더링 ────────────────────────────────────────
// 이 블록이 없어서 '##' 이 그대로 보이는 버그가 배포까지 살아남았습니다.
const s10 = html['10. 마크다운 — 헤딩·수평선·번호목록·표·링크'] ?? '';
check('## 이 글자로 남지 않음', !s10.includes('## '), s10.includes('## ') ? '← 헤딩 파싱 실패' : '');
check('--- 이 글자로 남지 않음', !s10.includes('---'));
check('## → h3', s10.includes('<h3') && s10.includes('확인된 책'));
check('### → h4', s10.includes('<h4') && s10.includes('함께 보면 좋은 책'));
check('--- → hr 요소', s10.includes('<hr'));
check('번호 목록은 ol', s10.includes('<ol'));
check('번호 목록 항목 2개', (s10.match(/<li>/g) ?? []).length >= 4);
check('불릿 목록은 ul', s10.includes('<ul'));
check('표 렌더', s10.includes('<table') && s10.includes('<th'));
check('인용문 렌더', s10.includes('<blockquote'));
check('굵게 렌더', s10.includes('<strong>수라간 요리 비기(秘記)</strong>'));
check('문단 안 줄바꿈 보존', s10.includes('<br'));
check('안전한 링크는 앵커', s10.includes('href="https://www.food.co.kr"'));
check('링크에 noopener', s10.includes('rel="noopener noreferrer"'));
check('javascript: 는 앵커로 만들지 않음', !s10.includes('href="javascript'));

// ── 대기 화면 ──────────────────────────────────────────────
const s11 = html['11. 대기 중 (답변·진행표시 둘 다 없음)'] ?? '';
check('대기 표시 렌더', s11.includes('class="thinking"'));
check('스피너 있음', s11.includes('class="spinner"'));
check('첫 단계 문구 (경과 0초)', s11.includes('준비하고 있어요') || s11.includes('Getting ready'));
// 초 카운터는 3초 뒤부터. SSR 은 0초라 없어야 합니다.
check('0초에는 경과 시간 숨김', !s11.includes('thinking__elapsed'));
// 단계 문구만 알림 대상 — 초 카운터까지 읽으면 스크린리더가 매초 숫자를 말합니다
check('단계 문구에 role=status', s11.includes('role="status"'));
check('대기 중에는 평가 없음', !s11.includes('fb__btn'));
check('대기 중에는 카드 없음', !s11.includes('class="card"'));

// 단계 전환이 서버 예산과 맞는지. SSR 로는 0초만 보이므로 함수를 직접 확인합니다.
//   백엔드: 도구 라운드 최대 11초(AGENT_BUDGET_MS vs ANSWER_RESERVE_MS 중 이른 쪽),
//           그 뒤 답변 생성, 전체 26초(REQUEST_BUDGET_MS).
//   문구가 실제 단계보다 앞서 나가면 "답변 작성 중" 인데 검색이 돌고 있게 됩니다.
const stageCases = [
  [0, 'wait.preparing'],
  [1, 'wait.preparing'],
  [2, 'wait.searching'],
  [8, 'wait.searching'],   // 도구 라운드 구간(≤11초)
  [12, 'wait.writing'],    // 도구 마감 이후 = 답변 생성 구간
  [20, 'wait.writing'],
  [22, 'wait.almost'],
  [30, 'wait.almost'],     // 예산을 넘겨도 마지막 단계를 유지
];
for (const [sec, want] of stageCases) {
  check(`${sec}초 → ${want}`, stageAt(sec).key === want, stageAt(sec).key);
}
check('검색 문구가 도구 마감(11초)을 넘지 않음', stageAt(11).key === 'wait.searching');

console.log(fail ? `\n✗ ${fail}건 실패` : '\n✓ 전부 통과');
process.exit(fail ? 1 : 0);
