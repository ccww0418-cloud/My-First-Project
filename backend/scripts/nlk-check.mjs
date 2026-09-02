/**
 * 국립중앙도서관 API 연결 확인 (실제 호출)
 *
 *   NLK_API_KEY=발급키 node scripts/nlk-check.mjs
 *   또는 배포 후 CloudShell 에서:
 *   NLK_API_KEY=$(aws ssm get-parameter --region us-east-1 \
 *     --name /bookbot/prod/NLK_API_KEY --with-decryption \
 *     --query Parameter.Value --output text) node backend/scripts/nlk-check.mjs
 *
 * ★ 왜 별도 스크립트가 필요한가
 *
 *   npm run test:features 의 국중 테스트는 **가짜 응답**으로 파싱만 검증합니다.
 *   실제 키가 유효한지는 확인하지 않습니다. 그리고 이 API 는
 *   **오류도 HTTP 200** 으로 주기 때문에, 상태 코드만 보는 확인은 거짓말을 합니다.
 *
 *   이 스크립트는 세 가지를 구분해서 알려줍니다.
 *     · 키가 유효하지 않다      → errorCode 011
 *     · 키는 되는데 결과가 없다  → result 배열이 빔
 *     · 정상 동작한다           → 파싱된 책이 나옴
 */
process.env.LOG_LEVEL ||= 'error';
process.env.BOOKBOT_LOCAL ||= '1';

const KEY = process.env.NLK_API_KEY || '';
const ENDPOINT = 'https://www.nl.go.kr/NL/search/openApi/search.do';

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};

const ERRORS = {
  '000': '국중 시스템 오류 — 잠시 후 다시 시도하세요',
  '010': '인증키가 전달되지 않았습니다 (NLK_API_KEY 가 비어 있음)',
  '011': '유효하지 않은 인증키 — 발급받은 키를 다시 확인하세요',
  '012': '500건 초과 조회 (이 스크립트에서는 발생하지 않아야 합니다)',
  '013': '카테고리 값 오류',
  '014': '파라미터 값 오류',
  '015': '검색어 또는 상세검색 값 누락',
  101: '국중 검색 서버 오류',
};

console.log(`\n${C.b('국립중앙도서관 API 연결 확인')}`);
console.log(C.d(`  엔드포인트 ${ENDPOINT}`));

if (!KEY) {
  console.log(`\n  ${C.r('✗')} NLK_API_KEY 가 설정되지 않았습니다.\n`);
  console.log('  로컬에서:');
  console.log(C.d('    NLK_API_KEY=발급키 node scripts/nlk-check.mjs\n'));
  console.log('  배포된 값으로 (CloudShell):');
  console.log(C.d('    NLK_API_KEY=$(aws ssm get-parameter --region us-east-1 \\'));
  console.log(C.d('      --name /bookbot/prod/NLK_API_KEY --with-decryption \\'));
  console.log(C.d('      --query Parameter.Value --output text) \\'));
  console.log(C.d('      node backend/scripts/nlk-check.mjs\n'));
  process.exit(2);
}
// 키 값은 절대 출력하지 않습니다. 길이와 앞 세 자만 보여줍니다.
console.log(C.d(`  키 ${KEY.slice(0, 3)}… (${KEY.length}자)`));

let fail = 0;
const step = (s) => console.log(`\n${C.b(`▶ ${s}`)}`);
const ok = (s, d = '') => console.log(`  ${C.g('✓')} ${s} ${C.d(d)}`);
const bad = (s, d = '') => {
  fail += 1;
  console.log(`  ${C.r('✗')} ${s} ${d ? C.y(d) : ''}`);
};

/** 원본 호출 — 어댑터를 거치지 않고 응답을 그대로 봅니다 */
async function raw(params) {
  const url = new URL(ENDPOINT);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* XML 이거나 HTML 오류 페이지 */
  }
  return { status: res.status, json, text };
}

// ────────────────────────────────────────────────────────────
step('1. 키가 유효한가 (원본 응답 확인)');
// ────────────────────────────────────────────────────────────
{
  const r = await raw({
    key: KEY, apiType: 'json', srchTarget: 'total',
    kwd: '토지', pageNum: 1, pageSize: 3, category: '도서',
  });

  console.log(C.d(`  HTTP ${r.status}  (★ 이 API 는 오류도 200 으로 옵니다)`));

  if (!r.json) {
    bad('응답이 JSON 이 아닙니다', r.text.slice(0, 120));
  } else if (r.json.errorCode) {
    bad(
      `errorCode ${r.json.errorCode}`,
      ERRORS[r.json.errorCode] ?? String(r.json.errorMsg ?? '').slice(0, 100),
    );
  } else {
    const n = Array.isArray(r.json.result) ? r.json.result.length : 0;
    if (n > 0) {
      ok('키 유효 + 검색 결과 수신', `총 ${r.json.total ?? '?'}건 중 ${n}건 수신`);
      const s = r.json.result[0];
      console.log(C.d(`     원본 title_info  = ${JSON.stringify(s.title_info)}`));
      console.log(C.d(`     원본 author_info = ${JSON.stringify(s.author_info)}`));
      console.log(C.d(`     원본 isbn        = ${JSON.stringify(s.isbn)}`));
      console.log(C.d(`     원본 kdc_name_1s = ${JSON.stringify(s.kdc_name_1s)}`));
    } else {
      bad('키는 통과했지만 결과가 0건', '"토지" 는 반드시 결과가 있어야 합니다');
    }
  }
}

// ────────────────────────────────────────────────────────────
step('2. 어댑터를 거친 결과 (정제가 맞는가)');
// ────────────────────────────────────────────────────────────
const { searchNlk, lookupNlk, lookupNlkByIsbn } = await import('../src/tools/nlk.mjs');
{
  const books = await searchNlk({ query: '토지 박경리', key: KEY, limit: 5 });
  if (!books.length) {
    bad('어댑터가 0권을 반환', '1번이 통과했다면 정제 단계 문제입니다');
  } else {
    ok(`검색 ${books.length}권`);
    for (const b of books.slice(0, 3)) {
      console.log(
        `     ${C.b(b.title)} / ${b.authors.join(', ') || '(저자 없음)'} ` +
          C.d(`${b.year ?? '?'}년 · ${b.publisher || '?'} · ISBN ${b.isbn13[0] ?? '없음'} · ${b.categories.join('/') || '분류없음'}`),
      );
    }
    // 정제가 안 됐으면 여기서 걸립니다
    const dirty = books.filter((b) => b.title.includes(' / '));
    dirty.length
      ? bad(`제목에 책임표시가 남았습니다 (${dirty.length}건)`, dirty[0].title)
      : ok('제목 정제 (책임표시 제거)');
    const roled = books.filter((b) => b.authors.some((a) => /지음|옮김|엮음/.test(a)));
    roled.length
      ? bad(`저자에 역할 표기가 남았습니다 (${roled.length}건)`, JSON.stringify(roled[0].authors))
      : ok('저자 정제 (역할 표기 제거)');
    const linked = books.filter((b) => b.links.nlk?.startsWith('https://www.nl.go.kr'));
    linked.length ? ok(`상세 링크 ${linked.length}건`) : bad('상세 링크가 없습니다');
  }
}

// ────────────────────────────────────────────────────────────
step('3. 제목+저자 정확 조회 (lookup_books 경로)');
// ────────────────────────────────────────────────────────────
{
  const books = await lookupNlk({ title: '토지', author: '박경리', key: KEY, limit: 5 });
  books.length
    ? ok(`상세검색 ${books.length}권`, books.map((b) => b.title).slice(0, 3).join(' / '))
    : bad('상세검색 0권', 'detailSearch·f1/v1 파라미터를 확인하세요');
}

// ────────────────────────────────────────────────────────────
step('4. ISBN 조회');
// ────────────────────────────────────────────────────────────
{
  // 국중 공식 문서의 예시 ISBN (토지)
  const books = await lookupNlkByIsbn({ isbn: '8984993727', key: KEY, limit: 3 });
  books.length
    ? ok(`ISBN 조회 ${books.length}권`, books[0].title)
    : bad('ISBN 조회 0건', '이 ISBN 은 국중 문서의 예시라 결과가 있어야 합니다');
}

// ────────────────────────────────────────────────────────────
step('5. 실제 검색 경로 (한국어 질의 → 어느 소스가 불리는가)');
// ────────────────────────────────────────────────────────────
{
  const hit = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('nl.go.kr')) hit.push('국립중앙도서관');
    else if (u.includes('aladin')) hit.push('알라딘');
    else if (u.includes('googleapis')) hit.push('Google Books');
    else if (u.includes('openlibrary')) hit.push('Open Library');
    else if (u.includes('hardcover')) hit.push('Hardcover');
    return origFetch(url, opts);
  };

  // DynamoDB 캐시를 끕니다 (로컬에는 테이블이 없고, 캐시 적중 시 호출이 안 보임)
  const { doc } = await import('../src/lib/ddb.mjs');
  doc.send = async () => ({});

  const { runTool } = await import('../src/tools/index.mjs');
  const res = await runTool(
    'search_books',
    { query: '한국 소설', language: 'ko' },
    { NLK_API_KEY: KEY, ALADIN_TTB_KEY: process.env.ALADIN_TTB_KEY || '' },
  );
  globalThis.fetch = origFetch;

  const uniq = [...new Set(hit)];
  console.log(C.d(`  호출된 소스: ${uniq.join(', ') || '(없음)'}`));

  uniq.includes('국립중앙도서관')
    ? ok('한국어 질의에서 국중이 호출됨')
    : bad('국중이 호출되지 않았습니다', 'tools/index.mjs 의 한국어 경로를 확인하세요');

  uniq.includes('Open Library')
    ? bad('Open Library 가 호출됐습니다', '한국어 경로에서는 빠져야 합니다')
    : ok('Open Library 미호출 (의도된 동작)');

  const fromNlk = (res.books ?? []).filter((b) => b.sources?.includes('nlk'));
  fromNlk.length
    ? ok(`최종 결과에 국중 출처 ${fromNlk.length}권`, fromNlk.map((b) => b.title).slice(0, 3).join(' / '))
    : bad('최종 결과에 국중 출처가 없습니다', '병합·정렬에서 밀렸거나 검색 결과가 0건입니다');
}

// ────────────────────────────────────────────────────────────
console.log(
  fail === 0
    ? `\n${C.g('✓ 국립중앙도서관 API 가 정상 연결되었습니다')}\n`
    : `\n${C.r(`✗ ${fail}건 확인 필요`)}\n`,
);
process.exit(fail === 0 ? 0 : 1);
