/**
 * 읽을 목록 저장소 회귀 테스트
 *
 *   npm run test:saved
 *
 * 브라우저 없이 로직만 확인합니다. localStorage 를 흉내내서 주입합니다.
 * useSyncExternalStore 를 쓰는 훅(useSavedBooks/useIsSaved)은 React 렌더가
 * 필요하므로 제외하고, 순수 함수만 검증합니다.
 */

let store = {};
let blocked = false;
globalThis.localStorage = {
  getItem: (k) => {
    if (blocked) throw new Error('blocked');
    return store[k] ?? null;
  },
  setItem: (k, v) => {
    if (blocked) throw new Error('blocked');
    store[k] = v;
  },
  removeItem: (k) => {
    delete store[k];
  },
};

const m = await import('../src/lib/savedBooks.js');
const { bookKey, saveBook, toggleBook, clearAll, isSaved, isPersistent, MAX_SAVED } = m;

let fail = 0;
const check = (label, cond, detail = '') => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label.padEnd(48)} ${detail}`);
};

const bk = (title, author, isbn) => ({
  id: `x:${Math.random()}`,
  title,
  authors: [author],
  isbn13: isbn ? [isbn] : [],
  links: {},
  sources: ['test'],
});

const items = () => JSON.parse(store['bookbot.saved'] ?? '{"items":[]}').items;

console.log('\n■ 중복 판정 (백엔드 merge.mjs 와 같은 원칙)');
check(
  'ISBN 같으면 같은 책',
  bookKey(bk('A', 'B', '9788936434120')) === bookKey(bk('다른 제목', 'C', '9788936434120')),
);
check('ISBN 없으면 제목+저자', bookKey(bk('소년이 온다', '한강')) === bookKey(bk('소년이 온다', '한강')));
check(
  '공백·대소문자 무시',
  bookKey(bk('The  Remains of the Day', 'X')) === bookKey(bk('theremainsoftheday', 'X')),
);
check('다른 책은 다른 키', bookKey(bk('A', 'B')) !== bookKey(bk('C', 'D')));

console.log('\n■ 다국어 제목 — 백엔드에서 실제로 터졌던 버그');
for (const [label, t, a] of [
  ['한국어', '소년이 온다', '한강'],
  ['일본어', 'ノルウェイの森', '村上春樹'],
  ['중국어', '三体', '刘慈欣'],
  ['러시아어', 'Преступление', 'Достоевский'],
  ['프랑스어', 'L’Étranger', 'Camus'],
]) {
  const k = bookKey(bk(t, a));
  check(`${label} 키 생성`, k.startsWith('t:') && k.length > 4, k.slice(0, 34));
}

console.log('\n■ 담기 · 중복 제거 · 순서');
clearAll();
saveBook(bk('책1', '저자1', '9781111111111'));
saveBook(bk('책1 다른표기', '저자1', '9781111111111'));
saveBook(bk('책2', '저자2'));
check('중복 제거되어 2권', items().length === 2, `${items().length}권`);
check('최근 담은 것이 앞', items()[0].title === '책2', items()[0].title);
check('isSaved 동작', isSaved(bk('책1', '저자1', '9781111111111')));

console.log('\n■ 저장 형태 축소 (localStorage 용량 보호)');
clearAll();
saveBook({
  ...bk('축소', '저자', '9782222222222'),
  description: 'x'.repeat(5000),
  categories: Array(50).fill('cat'),
  moods: Array(20).fill('mood'),
  contentWarnings: Array(10).fill('w'),
  coverUrl: 'https://x/y.jpg',
});
const one = items()[0];
check('description 버림', one.description === undefined);
check('categories 버림', one.categories === undefined);
check('moods 버림', one.moods === undefined);
check('표지·링크는 유지', one.coverUrl === 'https://x/y.jpg' && one.links !== undefined);
check('savedAt 기록', typeof one.savedAt === 'string');
const size = JSON.stringify(one).length;
check('권당 1KB 이하', size < 1024, `${size}바이트`);

console.log('\n■ 상한 (기존 항목을 몰래 지우지 않아야 함)');
clearAll();
for (let i = 0; i < MAX_SAVED; i += 1) {
  saveBook(bk(`책${i}`, 'a', `978${String(i).padStart(10, '0')}`));
}
const before = items().length;
const r = saveBook(bk('넘침', 'a', '9789999999999'));
check(`${MAX_SAVED}권까지 담김`, before === MAX_SAVED, `${before}권`);
check('넘으면 거부', r.ok === false && r.reason === 'full');
check('기존 항목 유지', items().length === MAX_SAVED);

console.log('\n■ 토글');
clearAll();
const b = bk('토글', '저자', '9783333333333');
check('첫 클릭 → 저장', toggleBook(b).saved === true);
check('두번째 클릭 → 해제', toggleBook(b).saved === false);
check('해제 후 없음', !isSaved(b));

console.log('\n■ 손상 데이터 · 저장 차단 환경');
store['bookbot.saved'] = '{ 깨진 JSON';
const m2 = await import('../src/lib/savedBooks.js?v=2');
check('깨진 JSON → 빈 목록 (예외 없음)', m2.isSaved(bk('아무거나', 'x')) === false);
store['bookbot.saved'] = JSON.stringify({ v: 999, items: [{ key: 'x', title: '옛버전' }] });
const m3 = await import('../src/lib/savedBooks.js?v=3');
check('버전 불일치 → 버림', m3.isSaved({ title: '옛버전' }) === false);
blocked = true;
const m4 = await import('../src/lib/savedBooks.js?v=4');
check('localStorage 차단 시 예외 없음', m4.saveBook(bk('차단', 'a')).ok === true);
check('영구 저장 아님을 알림', m4.isPersistent() === false);
blocked = false;
check('정상 환경에서는 영구 저장', isPersistent() === true);

console.log(fail ? `\n✗ ${fail}건 실패` : '\n✓ 전부 통과');
process.exit(fail ? 1 : 0);
