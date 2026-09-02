/**
 * 임시 검증 — agent.mjs 도구 루프.
 *
 * Bedrock 을 가짜로 바꿔서 네트워크 없이 루프 제어 흐름만 확인합니다.
 * BedrockRuntimeClient.prototype.send 를 agent.mjs import 전에 교체합니다.
 */
process.env.TABLE_NAME = 'bookbot';
process.env.LOG_LEVEL = 'error';
process.env.BEDROCK_MODEL_ID = 'fake.model';
process.env.MAX_TOOL_ITERATIONS = '2'; // 상한을 낮춰 빨리 재현

/**
 * BUDGET_TEST=1 로 실행하면 시간 예산을 0으로 두고,
 * 반복 상한이 아니라 **예산 초과**로 조기 마무리되는 경로를 검증합니다.
 * config.mjs 가 import 시점에 env 를 읽으므로 프로세스를 분리해야 합니다.
 */
const BUDGET_TEST = process.env.BUDGET_TEST === '1';
process.env.AGENT_BUDGET_MS = BUDGET_TEST ? '0' : '99999';

/**
 * LLM_DEADLINE_TEST=1 로 실행하면 **Bedrock 턴 자체**가 마감을 넘기는 경로를
 * 검증합니다.
 *
 * 왜 이 테스트가 필요한가 (실제 사고 경로):
 *   도구 라운드만 withDeadline 으로 묶고 Bedrock 턴은 열어두었습니다.
 *   config.mjs 주석의 "마무리 턴 3~8초" 는 가정일 뿐 코드로 강제되지 않아서,
 *   Bedrock 이 느린 날 통합 타임아웃(30초)을 넘겨 504 가 났고
 *   사용자는 답변을 한 글자도 받지 못했습니다.
 *   지금은 AbortSignal 로 스트림을 끊고 **그때까지 받은 텍스트는 살립니다.**
 */
const LLM_DEADLINE_TEST = process.env.LLM_DEADLINE_TEST === '1';
process.env.REQUEST_BUDGET_MS = LLM_DEADLINE_TEST ? '400' : '99999';

const sdk = await import('@aws-sdk/client-bedrock-runtime');

/** 가짜 스트림 청크 생성기 */
function textStream(text, stopReason = 'end_turn') {
  return (async function* () {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } };
    yield { messageStop: { stopReason } };
    yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } };
  })();
}

function toolUseStream(name, input, id) {
  return (async function* () {
    yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: id, name } } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify(input) } } } };
    yield { messageStop: { stopReason: 'tool_use' } };
    yield { metadata: { usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } } };
  })();
}

// ── 시나리오별 스크립트 ────────────────────────────────────────
let script = [];
let calls = [];

/**
 * 느린 스트림 — 텍스트 한 조각을 흘린 뒤 오래 멈춥니다.
 * abortSignal 이 오면 실제 SDK 처럼 AbortError 로 끊깁니다.
 */
function slowStream(text, signal) {
  return (async function* () {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } };
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      if (signal?.aborted) {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
    yield { messageStop: { stopReason: 'end_turn' } };
  })();
}

// opts 로 abortSignal 을 받아 넘깁니다 — 실제 SDK 의 send(command, {abortSignal}) 와 같은 모양.
sdk.BedrockRuntimeClient.prototype.send = async function fakeSend(command, opts) {
  const idx = calls.length;
  calls.push(structuredClone(command.input.messages));
  const step = script[idx];
  if (!step) throw new Error(`가짜 Bedrock: ${idx}번째 호출에 대한 스크립트가 없습니다`);
  if (step.throw) throw Object.assign(new Error(step.throw), { name: 'ValidationException' });
  return { stream: step.stream(opts?.abortSignal) };
};

const { runAgent } = await import('../src/agent.mjs');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

// ════════════════════════════════════════════════════════════
if (LLM_DEADLINE_TEST) {
  console.log('\n[F] Bedrock 턴이 마감을 넘겨도 부분 답변이 살아남는지');
  // 첫 턴이 텍스트 일부를 흘린 뒤 5초를 멈춥니다.
  // REQUEST_BUDGET_MS=400 이므로 400ms 에 끊겨야 합니다.
  script = [{ stream: (signal) => slowStream('앞부분만 도착한 답변', signal) }];
  calls = [];
  const notices = [];
  const t0 = Date.now();

  let threw = null;
  let rf;
  try {
    rf = await runAgent({
      userMessage: '느린 응답 재현',
      history: [],
      secrets: {},
      emit: (e) => { if (e.type === 'notice') notices.push(e.text); },
    });
  } catch (err) {
    threw = err;
  }
  const elapsed = Date.now() - t0;

  check('예외로 죽지 않음', threw === null, threw ? String(threw.message) : '');
  check('5초를 기다리지 않고 끊김', elapsed < 3000, `${elapsed}ms`);
  check('마감 전에 받은 텍스트는 살아남음',
    String(rf?.answer ?? '').includes('앞부분만 도착한 답변'), JSON.stringify(rf?.answer));
  check('마감으로 끊겨도 사용자에게 안내하지 않음', notices.length === 0, notices.join('|'));
  check('Bedrock 호출은 1회', calls.length === 1, `${calls.length}회`);

  console.log(`\n${failures === 0 ? '✓ 전부 통과' : `✗ ${failures}건 실패`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ════════════════════════════════════════════════════════════
if (BUDGET_TEST) {
  console.log('\n[D] 시간 예산 초과 → 반복 상한 전에 조기 마무리');
  // 첫 도구 라운드 직후 예산 초과로 판정되어야 하므로 Bedrock 호출은 2회
  // (탐색 1회 + 마무리 1회). 상한(2회)까지 안 가는 것이 핵심입니다.
  script = [
    { stream: () => toolUseStream('search_books', { query: 'sf' }, 'tuB') },
    { stream: () => textStream('시간이 촉박해 여기까지 정리했습니다.') },
  ];
  calls = [];
  const budgetNotices = [];
  const rb = await runAgent({
    userMessage: 'SF 추천',
    history: [],
    secrets: {},
    emit: (e) => { if (e.type === 'notice') budgetNotices.push(e.text); },
  });
  check('탐색 1회 + 마무리 1회 = 2회', calls.length === 2, `${calls.length}회`);
  check('답변이 비어 있지 않음', rb.answer.length > 0, JSON.stringify(rb.answer));
  // 예산 초과여도 사용자에게는 알리지 않습니다 (운영 로그에만 남김)
  check('예산 초과를 사용자에게 알리지 않음', budgetNotices.length === 0, budgetNotices.join('|'));
  const bMsgs = calls[1];
  const bLast = bMsgs[bMsgs.length - 1];
  check('마무리 지시문 포함', bLast?.content?.some((c) => typeof c.text === 'string' && c.text.includes('[시스템]')));

  // 예산이 0 이므로 도구를 기다리지 않고 마감 초과 toolResult 가 나와야 합니다.
  const bToolResult = bLast?.content?.find((c) => c.toolResult);
  check('도구 마감 초과가 error toolResult 로 처리', bToolResult?.toolResult?.status === 'error',
    JSON.stringify(bToolResult?.toolResult?.status));
  check('마감 초과 사실이 LLM 에 전달', 
    String(bToolResult?.toolResult?.content?.[0]?.text ?? '').includes('제한 시간'),
    String(bToolResult?.toolResult?.content?.[0]?.text ?? '').slice(0, 40));

  console.log(`\n${failures === 0 ? '✓ 전부 통과' : `✗ ${failures}건 실패`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ════════════════════════════════════════════════════════════
console.log('\n[A] 도구 없이 한 턴에 끝나는 경우');
script = [{ stream: () => textStream('추천드립니다.') }];
calls = [];
let r = await runAgent({ userMessage: '안녕', history: [], secrets: {}, emit: () => {} });
check('Bedrock 1회 호출', calls.length === 1, `${calls.length}회`);
check('답변 반환', r.answer === '추천드립니다.', JSON.stringify(r.answer));

// ════════════════════════════════════════════════════════════
console.log('\n[B] 반복 상한에 걸리는 경우 ← 예전 버그 지점');
// 2번 다 tool_use → 상한 도달 → 마무리 턴이 있어야 함
script = [
  { stream: () => toolUseStream('search_books', { query: 'sf' }, 'tu1') },
  { stream: () => toolUseStream('search_books', { query: 'sf2' }, 'tu2') },
  { stream: () => textStream('찾은 책으로 정리했습니다.') }, // 마무리 턴
];
calls = [];
const notices = [];
r = await runAgent({
  userMessage: 'SF 추천',
  history: [],
  secrets: {},
  emit: (e) => { if (e.type === 'notice') notices.push(e.text); },
});
check('마무리 턴이 실행됨 (3회 호출)', calls.length === 3, `${calls.length}회`);
check('답변이 비어 있지 않음', r.answer.length > 0, JSON.stringify(r.answer));
// ★ 반대로 뒤집힌 검증입니다.
//   전에는 "(검색을 여기서 마무리했습니다)" 를 사용자에게 띄웠습니다. 그런데
//   이 문구는 카드 **뒤에** 렌더되어 답변을 다 읽은 다음 마지막에 나타났고,
//   사용자는 무언가 실패했다고만 받아들이고 할 수 있는 일이 없었습니다.
//   검색을 몇 번 돌렸는지는 우리 사정입니다 — 운영에는 log.warn 으로 남깁니다.
check('내부 사정을 사용자에게 알리지 않음', notices.length === 0, notices.join('|'));

// 마무리 턴에 넘어간 메시지 검증: 마지막 user 메시지에 toolResult + 지시문이 함께 있어야 함
const finalMsgs = calls[2];
const lastUser = finalMsgs[finalMsgs.length - 1];
const hasToolResult = lastUser?.content?.some((c) => c.toolResult);
const hasInstruction = lastUser?.content?.some((c) => typeof c.text === 'string' && c.text.includes('[시스템]'));
check('마지막 user 메시지에 toolResult 포함', hasToolResult);
check('같은 메시지에 마무리 지시문 포함', hasInstruction);
check('user 메시지가 연속되지 않음 (역할 교대)', (() => {
  for (let i = 1; i < finalMsgs.length; i += 1) {
    if (finalMsgs[i].role === finalMsgs[i - 1].role) return false;
  }
  return true;
})(), finalMsgs.map((m) => m.role).join('→'));

// ════════════════════════════════════════════════════════════
console.log('\n[C] 도구 실행이 예외로 죽는 경우 ← toolUse/toolResult 짝 유지');
script = [
  { stream: () => toolUseStream('search_books', { query: 'x' }, 'tu9') },
  { stream: () => textStream('죄송합니다, 검색에 실패했어요.') },
];
calls = [];
let emitCount = 0;
r = await runAgent({
  userMessage: '책',
  history: [],
  secrets: {},
  emit: (e) => {
    emitCount += 1;
    // tool_start 에서 예외를 던져 runTool 밖에서 실패하는 상황을 만든다
    if (e.type === 'tool_start') throw new Error('emit 폭발');
  },
});
check('대화가 계속됨 (2회 호출)', calls.length === 2, `${calls.length}회`);
check('답변 반환', r.answer.length > 0, JSON.stringify(r.answer));
const cMsgs = calls[1];
const cLastUser = cMsgs[cMsgs.length - 1];
const errResult = cLastUser?.content?.find((c) => c.toolResult);
check('error 상태 toolResult 생성', errResult?.toolResult?.status === 'error', JSON.stringify(errResult?.toolResult?.status));
check('toolUseId 가 일치 (짝 유지)', errResult?.toolResult?.toolUseId === 'tu9', errResult?.toolResult?.toolUseId);

// ════════════════════════════════════════════════════════════
console.log('\n[E] 도구가 마감을 넘겨도 응답이 돌아오는지');
// 예산 0 이므로 도구 실행을 기다리지 않고 즉시 deadline_exceeded toolResult 가 되어야 함.
// (이 시나리오는 BUDGET_TEST=1 에서만 의미가 있으므로 여기서는 안내만)
console.log('  (BUDGET_TEST=1 실행에서 함께 검증됩니다)');

console.log(`\n${failures === 0 ? '✓ 전부 통과' : `✗ ${failures}건 실패`}`);
process.exit(failures === 0 ? 0 : 1);
