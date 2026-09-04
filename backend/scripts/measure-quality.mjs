#!/usr/bin/env node
/**
 * 배포된 서비스의 추천 품질을 측정합니다.
 *
 * 변경 전/후를 같은 기준으로 비교하려고 만들었습니다.
 * 품질은 "느낌" 이 아니라 아래 지표로 봅니다.
 *
 *   mentioned   답변이 《》 로 언급한 책 수      ← 추천을 몇 권 했나
 *   cards       화면에 카드로 나간 책 수         ← 검증을 통과한 책 수
 *   match       언급 중 카드가 붙은 비율         ← 검증 성공률
 *   truncated   답변이 잘렸는지 (max_tokens/deadline)
 *   scriptMix   카드 제목의 문자체계 분포        ← 요청과 무관한 책이 섞였는지
 *
 * 사용법
 *   node scripts/measure-quality.mjs                     기본 4문항
 *   node scripts/measure-quality.mjs --tag before        결과를 태그로 저장
 *   node scripts/measure-quality.mjs --compare before after
 *
 * 레이트리밋(분당 10)을 넘지 않게 문항 사이에 8초 쉽니다.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

const SITE = process.env.SITE_URL || 'https://d2cmff9bta4e7l.cloudfront.net';
const OUTDIR = 'scripts/.quality';
const GAP_MS = Number(process.env.GAP_MS || 8000);

const QUESTIONS = [
  { id: 'ko-mood',  q: '조용히 위로가 되는 한국 소설 추천해주세요', expect: 'hangul' },
  { id: 'genre',    q: '반전이 강한 미스터리 소설 추천해줘',        expect: 'any' },
  { id: 'free',     q: '무료로 지금 바로 읽을 수 있는 고전 알려줘',  expect: 'any' },
  { id: 'author',   q: '한강 작가의 책 알려줘',                     expect: 'hangul' },
];

// ── 지표 추출 ─────────────────────────────────────────────────────
const TITLE_RE = /《([^》]{1,80})》/g;

function scriptOf(s) {
  if (/[가-힣]/.test(s)) return 'ko';
  if (/[ぁ-んァ-ヶ]/.test(s)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(s)) return 'cjk';
  if (/[A-Za-z]/.test(s)) return 'latin';
  return 'other';
}

function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .replace(/[《》「」『』\[\]()**"'’·\-–—:：,.\s]/g, '')
    .toLowerCase();
}

function analyze(res, expect) {
  const answer = res.answer || '';
  const done = (res.events || []).find((e) => e.type === 'done') || {};
  const books = res.books || [];

  const mentioned = [...answer.matchAll(TITLE_RE)].map((m) => m[1].trim());
  const uniqMentioned = [...new Set(mentioned.map(norm))].filter(Boolean);

  const cardKeys = books.map((b) => norm(b.title));
  const matched = uniqMentioned.filter((m) =>
    cardKeys.some((c) => c.includes(m) || m.includes(c)));

  const turns = done.timing?.turns || [];
  const truncated = turns.some((t) => t.stopReason === 'max_tokens' || t.stopReason === 'deadline');

  const mix = {};
  for (const b of books) {
    const k = scriptOf(b.title || '');
    mix[k] = (mix[k] || 0) + 1;
  }
  const offScript = expect === 'hangul'
    ? books.filter((b) => scriptOf(b.title || '') !== 'ko').length
    : null;

  return {
    totalMs: done.totalMs ?? null,
    policyMs: done.timing?.policyMs ?? null,
    answerChars: answer.length,
    mentioned: uniqMentioned.length,
    cards: books.length,
    matched: matched.length,
    matchRate: uniqMentioned.length ? +(matched.length / uniqMentioned.length).toFixed(2) : null,
    toolCalls: (done.toolCalls || []).length,
    tools: (done.toolCalls || []).map((t) => (typeof t === 'string' ? t : t.name)).join(','),
    turnCount: turns.length,
    stopReasons: turns.map((t) => t.stopReason).join(','),
    truncated,
    inputTokens: done.usage?.inputTokens ?? null,
    outputTokens: done.usage?.outputTokens ?? null,
    scriptMix: mix,
    offScript,
    cardTitles: books.map((b) => b.title),
    turns,
  };
}

// ── 호출 ──────────────────────────────────────────────────────────
async function ask(q) {
  const t0 = Date.now();
  const r = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ message: q }),
  });
  const clientMs = Date.now() - t0;
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    const body = await r.text();
    return { error: `HTTP ${r.status}`, body: body.slice(0, 300), clientMs };
  }
  if (!ct.includes('json')) {
    return { error: `Content-Type ${ct}`, clientMs };
  }
  return { ...(await r.json()), clientMs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 표 출력 ───────────────────────────────────────────────────────
const COLS = [
  ['id', 10], ['totalMs', 8], ['answerChars', 6], ['mentioned', 5], ['cards', 5],
  ['matchRate', 6], ['toolCalls', 5], ['turnCount', 5], ['outputTokens', 7],
  ['truncated', 6], ['offScript', 6],
];

function row(o) {
  return COLS.map(([k, w]) => String(o[k] ?? '—').padStart(w)).join(' ');
}

function header() {
  return COLS.map(([k, w]) => k.slice(0, w).padStart(w)).join(' ');
}

// ── 비교 모드 ─────────────────────────────────────────────────────
function compare(a, b) {
  const A = JSON.parse(readFileSync(`${OUTDIR}/${a}.json`, 'utf8'));
  const B = JSON.parse(readFileSync(`${OUTDIR}/${b}.json`, 'utf8'));
  console.log(`\n비교  ${a}  →  ${b}\n`);
  const keys = ['totalMs', 'answerChars', 'mentioned', 'cards', 'matchRate',
                'toolCalls', 'outputTokens', 'inputTokens', 'offScript'];
  console.log('  문항        지표             전    후     변화');
  console.log('  ' + '─'.repeat(52));
  let worse = 0;
  for (const r of A.results) {
    const s = B.results.find((x) => x.id === r.id);
    if (!s) continue;
    for (const k of keys) {
      const x = r[k], y = s[k];
      if (x == null || y == null || x === y) continue;
      const d = typeof x === 'number' && typeof y === 'number' ? y - x : null;
      const bad = (['mentioned', 'cards', 'matchRate', 'answerChars'].includes(k) && d < 0)
               || (k === 'offScript' && d > 0);
      if (bad) worse++;
      const arrow = d == null ? '' : (d > 0 ? `+${d}` : `${d}`);
      console.log(`  ${r.id.padEnd(11)} ${k.padEnd(15)} ${String(x).padStart(5)} ${String(y).padStart(5)}   ${arrow}${bad ? '  ← 나빠짐' : ''}`);
    }
  }
  console.log('\n  ' + (worse ? `⚠️  나빠진 지표 ${worse}개 — 진행 보류` : '✅ 나빠진 지표 없음'));
  return worse ? 1 : 0;
}

// ── 실행 ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv[0] === '--compare') {
  process.exit(compare(argv[1], argv[2]));
}

const tag = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : 'run';

console.log(`\n대상  ${SITE}`);
console.log(`문항  ${QUESTIONS.length}개 · 사이 ${GAP_MS / 1000}초 대기 (레이트리밋 분당 10)\n`);
console.log('  ' + header());
console.log('  ' + '─'.repeat(header().length));

const results = [];
for (const [i, item] of QUESTIONS.entries()) {
  if (i) await sleep(GAP_MS);
  const res = await ask(item.q);
  if (res.error) {
    console.log(`  ${item.id.padStart(10)}  ✗ ${res.error} ${res.body || ''}`);
    results.push({ id: item.id, q: item.q, error: res.error });
    continue;
  }
  const m = analyze(res, item.expect);
  results.push({ id: item.id, q: item.q, expect: item.expect, ...m });
  console.log('  ' + row({ id: item.id, ...m }));
}

console.log('');
for (const r of results) {
  if (r.error) continue;
  console.log(`  [${r.id}] ${r.q}`);
  console.log(`     턴  ${(r.turns || []).map((t) => `${t.stopReason}/${t.ms ?? '?'}ms`).join('  ')}`);
  console.log(`     문자체계  ${JSON.stringify(r.scriptMix)}${r.offScript ? `   ← 요청 밖 ${r.offScript}권` : ''}`);
  console.log(`     카드  ${(r.cardTitles || []).slice(0, 6).join(' · ')}${(r.cardTitles || []).length > 6 ? ' …' : ''}`);
  console.log('');
}

const ok = results.filter((r) => !r.error);
const avg = (k) => ok.length ? +(ok.reduce((s, r) => s + (r[k] || 0), 0) / ok.length).toFixed(1) : null;
console.log(`  평균  전체 ${avg('totalMs')}ms · 언급 ${avg('mentioned')}권 · 카드 ${avg('cards')}장 · `
          + `출력 ${avg('outputTokens')}토큰 · 도구 ${avg('toolCalls')}회`);
console.log(`  잘림  ${ok.filter((r) => r.truncated).length} / ${ok.length}건`);

if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
const path = `${OUTDIR}/${tag}.json`;
writeFileSync(path, JSON.stringify({
  at: new Date().toISOString(), site: SITE, tag, results,
}, null, 2));
console.log(`\n  저장  ${path}\n`);
