/**
 * 문법 + 로드 검사.
 *
 * 왜 `node --check` 만으로는 부족한가 (실제로 놓친 사고):
 *   prompt.mjs 는 시스템 프롬프트를 템플릿 리터럴로 담고 있습니다.
 *   그 안에 백틱을 하나 쓰면 문자열이 거기서 끊기고, 뒤에 남은 마크다운이
 *   **코드로 해석됩니다.**
 *
 *       ★ 제목은 굵게(`**제목**`)로 쓰지 마세요
 *                     ↑ 여기서 템플릿 문자열이 닫힘
 *
 *   이건 문법적으로 유효한 JS 라서 `node --check` 를 통과합니다.
 *   그런데 모듈을 실제로 불러오면 ReferenceError: 제목 is not defined 로 죽습니다.
 *   즉 검사는 초록불인데 Lambda 는 첫 요청에서 500 을 냅니다.
 *
 *   → 파싱만 하지 않고 **전부 import** 해서 모듈 평가까지 확인합니다.
 *     import 는 미해결 import 경로, 없는 export 참조, 모듈 최상단에서 던지는
 *     예외까지 같이 잡아줍니다.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = new URL('../src/', import.meta.url);
const SRC_DIR = SRC.pathname;

// 모듈 최상단에서 설정을 읽는 파일들이 있어 최소 환경값을 채워둡니다.
// 값의 정합성은 /api/health 가 검사합니다. 여기서는 로드만 확인합니다.
process.env.BEDROCK_MODEL_ID ||= 'check.placeholder';
process.env.TABLE_NAME ||= 'check';
process.env.AWS_REGION ||= 'us-east-1';
process.env.LOG_LEVEL ||= 'error';

/** src 아래 .mjs 전부 */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (name.endsWith('.mjs')) out.push(full);
  }
  return out.sort();
}

const files = collect(SRC_DIR);
let failed = 0;

// ── 1단계: 파싱 ──────────────────────────────────────────────
// import 되지 않는 파일도 검사 대상에 넣기 위해 따로 돕니다.
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`✗ 파싱 실패  ${relative(SRC_DIR, f)}`);
    console.error(String(err.stderr || err.message).trim().split('\n').slice(0, 4).join('\n'));
  }
}

// ── 2단계: 로드(모듈 평가) ───────────────────────────────────
for (const f of files) {
  try {
    await import(pathToFileURL(f).href);
  } catch (err) {
    failed += 1;
    console.error(`✗ 로드 실패  ${relative(SRC_DIR, f)}`);
    console.error(`   ${err.name}: ${err.message}`);
  }
}

// ── 3단계: 프롬프트가 온전한지 ───────────────────────────────
// 위 백틱 사고는 프롬프트를 조용히 잘라먹습니다. 로드는 되면서
// 프롬프트만 짧아지는 변형도 있습니다.
//
// 길이 하한(4,000자)으로 잡았더니 프롬프트를 줄일 때 걸렸고, 그래서 절 표지
// 확인으로 바꿨습니다. 그 삭감은 나중에 되돌렸지만(품질이 나빠졌습니다) 검사
// 방식은 이쪽이 맞습니다 — 잘림 탐지에는 길이보다 표지가 정확합니다.
//
// 앞·중간·끝을 골라 담습니다. 템플릿 리터럴이 중간에 끊기면 뒤쪽이 사라집니다.
const PROMPT_MARKERS = [
  '# 0. 기본 동작',
  '# 2. 절대 규칙',
  '# 도구 사용 전략',
  '# 답변 형식',
  '# 검색어 언어',
];
try {
  const { SYSTEM_PROMPT } = await import(new URL('prompt.mjs', SRC).href);
  const text = SYSTEM_PROMPT ?? '';
  const missing = PROMPT_MARKERS.filter((m) => !text.includes(m));
  if (missing.length) {
    failed += 1;
    console.error(`✗ 시스템 프롬프트에 빠진 절이 있습니다: ${missing.join(', ')}`);
    console.error('   템플릿 리터럴이 중간에 끊겼을 수 있습니다. 백틱을 확인하세요.');
    console.error('   절 제목을 일부러 바꿨다면 scripts/check.mjs 의 PROMPT_MARKERS 도 맞춰주세요.');
  } else {
    console.log(`   시스템 프롬프트 ${text.length}자 / ${PROMPT_MARKERS.length}개 절 확인`);
  }
} catch (err) {
  failed += 1;
  console.error(`✗ 프롬프트 확인 실패: ${err.message}`);
}

if (failed) {
  console.error(`\n✗ ${failed}건 실패`);
  process.exit(1);
}
console.log(`syntax OK (${files.length}개 파일 파싱 + 로드)`);
