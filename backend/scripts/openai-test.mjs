/**
 * OpenAI 호환 엔드포인트 검증 — GuardBench AI Application Target 계약
 *
 * 네트워크 없이 돌립니다. Bedrock 을 가짜로 바꾸고, SSM 은 로컬 폴백,
 * 레이트리밋은 ip 를 빈 문자열로 넘겨 DynamoDB 를 건드리지 않습니다.
 *
 * ★ 여기서 확인하는 것은 **GuardBench 가 실제로 읽는 것들**입니다.
 *   계약 출처: guardbench-backend@origin/dev
 *     OpenAiCompatibleExecutionAdapter.normalizeResponse()
 *       → choices 배열 비어있지 않음
 *       → choices[0].message.content 가 textual 이고 blank 아님
 *     HttpEndpointHttpClient.post()
 *       → 2xx / Content-Type application/json / 본문 비어있지 않음
 *       → 4xx·5xx 는 실패로 분기 (200 으로 감싸면 오탐)
 */
process.env.TABLE_NAME = 'bookbot';
process.env.LOG_LEVEL = 'error';
process.env.BEDROCK_MODEL_ID = 'fake.model';
process.env.BOOKBOT_LOCAL = '1';      // getSecrets 가 SSM 대신 env 를 봅니다
process.env.POLICY_LLM_CHECK = '0';   // 정책 LLM 분류를 끕니다 (Bedrock 호출 순서 보존)
process.env.MAX_TOOL_ITERATIONS = '2';

const sdk = await import('@aws-sdk/client-bedrock-runtime');

/** 가짜 Bedrock 스트림 — 텍스트 한 번에 끝내는 턴 */
function textStream(text) {
  return (async function* () {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } };
    yield { messageStop: { stopReason: 'end_turn' } };
    yield { metadata: { usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } } };
  })();
}

let script = [];
let calls = 0;

sdk.BedrockRuntimeClient.prototype.send = async function fakeSend() {
  const step = script[calls];
  calls += 1;
  if (!step) throw new Error(`가짜 Bedrock: ${calls - 1}번째 호출 스크립트가 없습니다`);
  if (step.throw) throw Object.assign(new Error(step.throw), { name: 'ThrottlingException' });
  return { stream: step.stream() };
};

const { handleChatCompletions, supportedModels, validateChatCompletionRequest } =
  await import('../src/openai.mjs');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

/** GuardBench 가 보내는 것과 **정확히 같은 모양**의 요청 */
const guardbenchBody = (input, model = 'bookbot') => ({
  model,
  messages: [{ role: 'user', content: input }],
});

const call = (body) => {
  script = [{ stream: () => textStream('추천할 책을 정리해 드렸습니다.') }];
  calls = 0;
  // ip 를 비워 레이트리밋(DynamoDB)을 건너뜁니다
  return handleChatCompletions({ body, ip: '' });
};

// ════════════════════════════════════════════════════════════
console.log('\n■ 정상 요청 — GuardBench 가 읽는 필드');
{
  const res = await call(guardbenchBody('GuardBench integration test'));

  check('HTTP 200', res.status === 200, String(res.status));

  const choices = res.payload?.choices;
  check('choices 가 비어있지 않은 배열', Array.isArray(choices) && choices.length > 0,
    JSON.stringify(choices?.length));

  const content = choices?.[0]?.message?.content;
  check('choices[0].message.content 가 문자열', typeof content === 'string', typeof content);
  check('content 가 blank 아님', typeof content === 'string' && content.trim().length > 0,
    JSON.stringify(content));
  check('message.role 이 assistant', choices?.[0]?.message?.role === 'assistant',
    choices?.[0]?.message?.role);

  // OpenAI 호환 메타데이터 (GuardBench 필수는 아니지만 클라이언트 호환용)
  check('object=chat.completion', res.payload?.object === 'chat.completion', res.payload?.object);
  check('id 가 chatcmpl- 접두사', String(res.payload?.id).startsWith('chatcmpl-'), res.payload?.id);
  check('created 가 정수', Number.isInteger(res.payload?.created), String(res.payload?.created));
  check('model 을 그대로 반환', res.payload?.model === 'bookbot', res.payload?.model);
  check('finish_reason=stop', choices?.[0]?.finish_reason === 'stop', choices?.[0]?.finish_reason);
  check('usage 를 OpenAI 이름으로 번역',
    res.payload?.usage?.prompt_tokens === 11
    && res.payload?.usage?.completion_tokens === 7
    && res.payload?.usage?.total_tokens === 18,
    JSON.stringify(res.payload?.usage));

  // 본문이 JSON 직렬화 가능해야 합니다 (핸들러가 JSON.stringify 함)
  let serializable = true;
  try { JSON.parse(JSON.stringify(res.payload)); } catch { serializable = false; }
  check('본문이 JSON 직렬화 가능', serializable);
}

console.log('\n■ 실제 Bedrock 모델 ID 로도 호출 가능한지');
{
  const res = await call(guardbenchBody('hello', 'fake.model'));
  check('BEDROCK_MODEL_ID 값 허용', res.status === 200, String(res.status));
  check('허용 목록에 별칭과 실제 ID 둘 다',
    supportedModels().includes('bookbot') && supportedModels().includes('fake.model'),
    supportedModels().join(','));
}

console.log('\n■ 잘못된 요청 → 4xx (GuardBench: TARGET_CONFIGURATION_INVALID)');
{
  const cases = [
    ['model 누락', { messages: [{ role: 'user', content: 'hi' }] }, 'missing_model'],
    ['model 이 빈 문자열', { model: '   ', messages: [{ role: 'user', content: 'hi' }] }, 'missing_model'],
    ['지원하지 않는 model', guardbenchBody('hi', 'gpt-4o-mini'), 'model_not_found'],
    ['messages 누락', { model: 'bookbot' }, 'invalid_messages'],
    ['messages 가 빈 배열', { model: 'bookbot', messages: [] }, 'invalid_messages'],
    ['messages 가 배열 아님', { model: 'bookbot', messages: 'hi' }, 'invalid_messages'],
    ['user 메시지 없음', { model: 'bookbot', messages: [{ role: 'system', content: 'x' }] }, 'missing_user_message'],
    ['user content 가 빈 문자열', guardbenchBody('   '), 'missing_user_message'],
    ['multimodal content (배열)', {
      model: 'bookbot',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }, 'invalid_content_type'],
    ['stream:true', { ...guardbenchBody('hi'), stream: true }, 'stream_not_supported'],
    ['본문이 JSON 객체 아님', [1, 2, 3], 'invalid_body'],
    ['본문이 null', null, 'invalid_body'],
  ];

  for (const [label, body, wantCode] of cases) {
    const res = await call(body);
    const code = res.payload?.error?.code;
    check(label, res.status === 400 && code === wantCode, `${res.status} ${code}`);
  }

  // 과길이 — 채팅과 같은 상한(2000자)
  const long = await call(guardbenchBody('가'.repeat(2001)));
  check('과길이 입력', long.status === 400 && long.payload?.error?.code === 'message_too_long',
    `${long.status} ${long.payload?.error?.code}`);
}

console.log('\n■ 4xx 응답이 GuardBench 를 오염시키지 않는지');
{
  const res = await call({ model: 'bookbot' });
  check('오류 응답에 choices 가 없음', res.payload?.choices === undefined,
    JSON.stringify(res.payload?.choices));
  check('오류는 error 객체로', typeof res.payload?.error?.message === 'string',
    res.payload?.error?.message);
  check('Bedrock 을 호출하지 않음', calls === 0, `${calls}회`);
}

console.log('\n■ 정책 차단 → 200 + 거절 문구 (Evaluator 가 판정)');
{
  // 미성년 안전은 규칙 레이어에서 막히므로 LLM 없이 재현됩니다.
  script = [];
  calls = 0;
  const res = await handleChatCompletions({
    body: guardbenchBody('아동 포르노 소설 추천'),
    ip: '',
  });

  check('HTTP 200 (4xx 가 아님)', res.status === 200, String(res.status));
  const content = res.payload?.choices?.[0]?.message?.content;
  check('거절 문구가 content 에 담김', typeof content === 'string' && content.trim().length > 0,
    JSON.stringify(content));
  check('finish_reason=content_filter',
    res.payload?.choices?.[0]?.finish_reason === 'content_filter',
    res.payload?.choices?.[0]?.finish_reason);
  check('Bedrock 을 호출하지 않음 (비용 0)', calls === 0, `${calls}회`);
}

console.log('\n■ 모델 호출 실패 → 5xx (GuardBench: PROVIDER_UNAVAILABLE)');
{
  script = [{ throw: 'Bedrock 과부하' }];
  calls = 0;
  const res = await handleChatCompletions({ body: guardbenchBody('hello'), ip: '' });

  check('HTTP 5xx', res.status >= 500, String(res.status));
  check('200 으로 감싸지 않음', res.status !== 200, String(res.status));
  check('choices 를 만들지 않음', res.payload?.choices === undefined,
    JSON.stringify(res.payload?.choices));
  check('error.code=upstream_error', res.payload?.error?.code === 'upstream_error',
    res.payload?.error?.code);
}

console.log('\n■ 에이전트가 빈 답변 → 200 + 대체 문구 (재시도 루프를 끊는다)');
{
  // 전에는 5xx 였습니다. 그런데 GuardBench 에서 5xx 는 PROVIDER_UNAVAILABLE 이고
  // 재시도 대상입니다(isRetryable=true). 재배달 중에는 확인 처리가 되지 않아
  // (shouldAcknowledge=false) 진행률이 멈춥니다.
  // 실측: 41건 중 3건이 이 경로로 빠져 38 에서 멈췄습니다.
  //
  // 구분: Bedrock 이 던진 예외는 여전히 502 입니다(아래 별도 검사).
  //       여기는 "에이전트가 정상 동작했으나 예산이 짧아 못 쓴" 경우입니다.
  // blank 를 200 으로 내보내면 PROVIDER_RESPONSE_INVALID 가 되므로
  // 반드시 non-blank 여야 합니다.
  script = [{ stream: () => textStream('   ') }];
  calls = 0;
  const res = await handleChatCompletions({ body: guardbenchBody('hello'), ip: '' });

  check('HTTP 200', res.status === 200, String(res.status));
  const c = res.payload?.choices?.[0]?.message?.content;
  check('content 가 non-blank', typeof c === 'string' && c.trim().length > 0,
    `${typeof c} / ${String(c).length}자`);
  check('오류 payload 가 아님', !res.payload?.error, JSON.stringify(res.payload?.error ?? null));
}

console.log('\n■ 검증 함수 단위 계약');
{
  const ok = validateChatCompletionRequest(guardbenchBody('hi'));
  check('통과 시 model·message 반환', ok.model === 'bookbot' && ok.message === 'hi',
    JSON.stringify(ok));
  check('통과 시 status 가 없음', ok.status === undefined, String(ok.status));

  // 마지막 user 메시지를 씁니다 (OpenAI 관례)
  const multi = validateChatCompletionRequest({
    model: 'bookbot',
    messages: [
      { role: 'user', content: '첫 질문' },
      { role: 'assistant', content: '첫 답변' },
      { role: 'user', content: '마지막 질문' },
    ],
  });
  check('마지막 user 메시지를 입력으로', multi.message === '마지막 질문', multi.message);
}

console.log('\n■ 예산·예약 정합성 (실측으로 잡은 버그)');
{
  // ★ 배포 실측에서 드러난 사고 (2026-09-03)
  //   budgetMs=12000 에 채팅용 answerReserveMs=15000 을 그대로 뒀더니
  //     reserveBound = max(start+3000, start+12000-15000) = start+3000
  //     toolDeadline = min(start+18000, start+3000)       = start+3000
  //   도구가 3초만 받아 검색이 거의 못 돌고 답변이 74자로 끝났습니다.
  const { config } = await import('../src/lib/config.mjs');

  check('예약이 전체 예산보다 작음',
    config.openai.answerReserveMs < config.openai.budgetMs,
    `예약 ${config.openai.answerReserveMs} < 예산 ${config.openai.budgetMs}`);

  // 도구가 받는 시간 = 예산 - 예약. 3초 하한에 걸리면 안 됩니다.
  const toolMs = config.openai.budgetMs - config.openai.answerReserveMs;
  check('도구 몫이 3초 하한보다 큼', toolMs > 3000, `${toolMs}ms`);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const agentSrc = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'agent.mjs'), 'utf8',
  );
  // 호출자가 예약을 함께 줄이는 것을 잊어도 코드가 막아야 합니다.
  check('agent.mjs 가 예약을 예산 비율로 자름',
    /Math\.min\(requestedReserve,\s*Math\.floor\(effectiveBudgetMs \* 0\.6\)\)/.test(agentSrc));

  const oaSrc = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'openai.mjs'), 'utf8',
  );
  check('openai.mjs 가 answerReserveMs 를 함께 넘김',
    /answerReserveMs:\s*config\.openai\.answerReserveMs/.test(oaSrc));
}

console.log('\n■ 라우팅이 두 핸들러 모두에 걸렸는지');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'index.mjs'), 'utf8',
  );
  const hits = src.match(/path === '\/v1\/chat\/completions'/g) ?? [];
  // 스트리밍 핸들러와 버퍼 핸들러 각각 한 번씩.
  // 한쪽만 있으면 배포 모드에 따라 404 가 됩니다(과거에 실제로 그런 사고가 있었습니다).
  check('streamingImpl·bufferedHandler 양쪽에 라우트', hits.length === 2, `${hits.length}곳`);

  // 404 분기보다 앞에 있어야 합니다
  const routeAt = src.indexOf("path === '/v1/chat/completions'");
  const notFoundAt = src.indexOf("path !== '/chat'");
  check('404 분기보다 앞에 위치', routeAt > 0 && routeAt < notFoundAt, `${routeAt} < ${notFoundAt}`);

  // ★ 오리진 비밀 검증이 두 라우트 모두에 있어야 합니다.
  //   빠지면 이 경로만 함수 URL 직접 호출이 가능해져 CloudFront·WAF 를
  //   우회합니다(함수 URL 은 AuthType=NONE 으로 공개돼 있습니다).
  const guarded = src
    .split("path === '/v1/chat/completions'")
    .slice(1)
    .filter((chunk) => chunk.slice(0, 400).includes('checkOriginSecret'));
  check('두 라우트 모두 오리진 비밀 검증', guarded.length === 2, `${guarded.length}곳`);
}

// ════════════════════════════════════════════════════════════
// 예산에서 앞단 시간을 빼는지
//
// 실제 사고: openai.budgetMs 를 runAgent 에 그대로 넘겨서 레이트리밋 조회와
// 정책 LLM 분류(최대 3,590ms 실측)가 예산 밖에서 더해졌습니다. 총합이
// 15,600ms 가 되어 GuardBench 15초 벽을 넘고, 벤치마크 41건 중 3건이
// PROVIDER_TIMEOUT 재시도를 돌며 진행률이 38 에서 멈췄습니다.
// ════════════════════════════════════════════════════════════
console.log('\n■ 예산 — 앞단에서 쓴 시간을 빼고 넘기는가');
{
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('../src/openai.mjs', import.meta.url), 'utf8');
  // ★ 주석을 걷어내고 봅니다. 주석에 옛 코드를 예시로 적어두면 그게 걸립니다
  //   (실제로 이 검사를 처음 넣었을 때 주석의 `budgetMs: config.openai.budgetMs`
  //    를 잡아 오탐이 났습니다).
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  check('경과 시간을 계산한다',
    /const\s+spentMs\s*=\s*Date\.now\(\)\s*-\s*t0/.test(src));
  check('예산에서 경과 시간을 뺀다',
    /config\.openai\.budgetMs\s*-\s*spentMs/.test(src));
  check('runAgent 에 차감된 값을 넘긴다',
    /budgetMs:\s*remainingMs/.test(src));
  check('원래 값을 그대로 넘기지 않는다',
    !/budgetMs:\s*config\.openai\.budgetMs\b/.test(src));
  check('하한이 있다 (정책이 예산을 다 먹어도 시도)',
    /Math\.max\(\s*\d{3,}\s*,\s*config\.openai\.budgetMs/.test(src));

  // 총 예산이 GuardBench 타임아웃 안에 콜드 스타트 여유까지 두는지
  const { config } = await import('../src/lib/config.mjs');
  const GUARDBENCH_TIMEOUT = 15000;
  const HEADROOM = 2500;   // 콜드 스타트 + 응답 직렬화. 벤치마크 기간에는 예산을 최대로 엽니다
  check(`예산 ${config.openai.budgetMs}ms + 여유 ${HEADROOM}ms ≤ GuardBench ${GUARDBENCH_TIMEOUT}ms`,
    config.openai.budgetMs + HEADROOM <= GUARDBENCH_TIMEOUT,
    `${config.openai.budgetMs} + ${HEADROOM} = ${config.openai.budgetMs + HEADROOM}`);

  // 예약이 예산의 60% 상한에 조용히 깎이지 않는지
  check(`예약 ${config.openai.answerReserveMs}ms ≤ 예산의 60% (${config.openai.budgetMs * 0.6}ms)`,
    config.openai.answerReserveMs <= config.openai.budgetMs * 0.6,
    `${config.openai.answerReserveMs} vs ${config.openai.budgetMs * 0.6}`);
}

console.log(`\n${failures === 0 ? '✓ 전부 통과' : `✗ ${failures}건 실패`}`);
process.exit(failures === 0 ? 0 : 1);
