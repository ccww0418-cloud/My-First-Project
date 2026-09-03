/**
 * Bedrock Converse(Stream) + 도구 루프
 *
 * 왜 ConverseStream인가:
 *   - InvokeModel은 모델마다 요청/응답 JSON 스키마가 달라서 모델을 바꾸면 코드를 고쳐야 합니다.
 *     Converse는 통일된 스키마라 modelId만 바꿔도 됩니다. (Claude → Nova → Llama)
 *   - toolConfig로 function calling이 표준화되어 있습니다.
 *   - 스트리밍 이벤트가 정규화되어 있어 SSE로 그대로 흘려보내기 쉽습니다.
 *
 * 도구 루프 구조:
 *   [사용자 메시지] → ConverseStream
 *      ↓ stopReason === 'tool_use'
 *   도구 병렬 실행 → toolResult 메시지 추가 → 다시 ConverseStream
 *      ↓ stopReason === 'end_turn'
 *   완료
 *
 *   MAX_TOOL_ITERATIONS로 상한을 둡니다. 없으면 LLM이 무한히 도구를 부르며
 *   Bedrock 요금을 태울 수 있습니다. (중요한 안전장치)
 */

import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from './lib/config.mjs';
import { log } from './lib/log.mjs';
import { fuzzyKey } from './lib/isbn.mjs';
import { SYSTEM_PROMPT, detectReplyLanguage, languageDirective } from './prompt.mjs';
import { toolConfig, runTool, TOOL_LABELS } from './tools/index.mjs';
import { selectForCards, logSelection, missingTitles } from './tools/present.mjs';

/**
 * 보충 조회에 쓸 추가 시간 예산.
 *
 * 에이전트 예산(API Gateway 모드 18초)을 다 쓴 뒤에 도는 단계입니다.
 * 통합 타임아웃이 30초라 여유가 약 10초 남습니다. 그중 일부만 씁니다.
 */
const BACKFILL_BUDGET_MS = Number(process.env.BACKFILL_BUDGET_MS || 6000);

/** 한 번에 보충할 최대 권수. 많으면 지연이 커집니다. */
const BACKFILL_MAX_ITEMS = Number(process.env.BACKFILL_MAX_ITEMS || 8);

/**
 * 도구 호출을 멈추고 답변을 마무리하라는 지시.
 *
 * toolResult 블록과 **같은 user 메시지**에 텍스트 블록으로 넣습니다.
 * 별도 메시지로 push 하면 user 메시지가 연속되어 Bedrock의 역할 교대 규칙을
 * 위반합니다. 또 toolConfig 를 아예 제거하는 방법도 안 됩니다 —
 * 히스토리에 toolUse 블록이 남아 있으면 Bedrock이 ValidationException 을 냅니다.
 */
const FINALIZE_INSTRUCTION =
  '[시스템] 검색 예산을 모두 사용했습니다. 더 이상 도구를 호출하지 마세요. '
  + '지금까지 확보한 위 결과만으로 사용자에게 최종 답변을 작성하세요. '
  + '결과가 부족하면 부족하다고 솔직히 말하고 다시 물어보세요.';

const bedrock = new BedrockRuntimeClient({
  region: config.bedrock.region,
  maxAttempts: 3, // ThrottlingException에 대해 SDK가 지수 백오프로 재시도
});

/**
 * @typedef {(event: object) => void} Emit
 *   프론트엔드로 보낼 SSE 이벤트를 방출하는 콜백.
 *   이벤트 종류:
 *     { type:'delta',      text }                     텍스트 조각
 *     { type:'tool_start', name, label, input }       도구 실행 시작
 *     { type:'tool_end',   name, label, count, ms }   도구 실행 완료
 *     { type:'books',      items }                    책 카드 데이터 (사이드 채널)
 *     { type:'usage',      inputTokens, outputTokens } 토큰 사용량
 */

/**
 * 한 번의 사용자 발화를 처리한다.
 *
 * @param {object} params
 * @param {string} params.userMessage
 * @param {Array} params.history        [{role, content:[{text}]}]
 * @param {object} params.secrets       SSM에서 읽은 API 키들
 * @param {Emit}  params.emit
 * @returns {Promise<{ answer: string, books: Array, usage: object, toolCalls: string[] }>}
 */
/**
 * 의도별 추가 지시.
 *
 * 왜 시스템 프롬프트에 붙이는가:
 *   시스템 프롬프트는 캐시·재사용 대상이라 매 요청마다 바꾸지 않는 편이 좋지만,
 *   이 한 줄이 답변의 **첫 문장 형식**을 결정합니다. 사용자 메시지에 섞어 넣으면
 *   사용자가 그 지시를 쓴 것처럼 보여 인젝션 방어와 충돌합니다.
 *
 * SERVICE 는 차단이 아닙니다. "직접은 못 하지만 관련 책은 추천" 으로
 * 전환하라는 표시입니다.
 */
function intentDirective(intent) {
  if (intent === 'SERVICE') {
    return [
      '',
      '# 이번 요청에 대한 지시',
      '',
      '이 요청은 책 추천이 아니라 다른 작업을 직접 해달라는 요구로 분류되었습니다.',
      '시스템 프롬프트 1절의 형식을 그대로 따르세요.',
      '  1) 직접 할 수 없다는 것을 **한 문장으로 짧게** 밝힙니다.',
      '  2) 곧바로 그 주제와 관련된 책을 도구로 찾아 추천합니다.',
      '거절만 하고 끝내지 마세요. 반드시 관련 분야의 책을 찾아 제시해야 합니다.',
    ].join('\n');
  }
  return '';
}

/**
 * @param {object} params
 * @param {number} [params.budgetMs] 요청 전체 마감을 덮어씁니다. 생략하면
 *   `config.limits.requestBudgetMs`(26초)를 씁니다.
 *
 *   왜 인자로 뺐는가: GuardBench 의 HTTP Target 어댑터는 요청 타임아웃이
 *   기본 15초입니다(`HttpEndpointProperties.DEFAULT_REQUEST_TIMEOUT_MS`).
 *   26초 예산으로 답하면 GuardBench 쪽에서 `PROVIDER_TIMEOUT` 이 되어
 *   테스트 결과가 "우리 서비스가 응답하지 않았다" 로 기록됩니다.
 *   환경 변수를 바꾸면 실서비스 채팅까지 같이 짧아지므로 호출자별로 받습니다.
 */
export async function runAgent({
  userMessage, history = [], secrets = {}, emit, intent = 'BOOK', budgetMs,
}) {
  /** @type {Array} Bedrock에 넘길 메시지 배열 (toolUse/toolResult 포함) */
  const messages = [...history, { role: 'user', content: [{ text: userMessage }] }];

  /** 화면에 렌더링할 책들을 ID 기준으로 누적 (중복 제거) */
  const bookMap = new Map();
  const toolCalls = [];
  let finalText = '';
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  // ★ 답변 언어를 **이번 턴의 사용자 메시지**로 판정합니다.
  //
  //   히스토리가 아니라 현재 입력을 봅니다. 앞선 턴이 한국어로 잘못 나갔더라도
  //   지금 입력이 영어면 영어로 돌아옵니다 — 대화 이력 오염을 끊는 지점입니다.
  //   (실측 사고: 영어로 세 번 물었는데 1번 턴이 한국어로 나가자 2·3번도 한국어)
  const replyLanguage = detectReplyLanguage(userMessage);

  const startedAt = Date.now();

  // 요청 전체를 감싸는 하나의 마감. 도구·LLM 턴·보충 조회가 전부 이 안에 듭니다.
  // 호출자가 budgetMs 를 주면 그것을 씁니다(GuardBench 처럼 더 짧은 마감이
  // 걸린 클라이언트용). 0 이나 음수는 설정 실수로 보고 기본값으로 되돌립니다.
  const effectiveBudgetMs = Number.isFinite(budgetMs) && budgetMs > 0
    ? budgetMs
    : config.limits.requestBudgetMs;
  const requestDeadlineAt = startedAt + effectiveBudgetMs;

  // 도구 라운드 마감 — 답변 생성 몫을 먼저 떼어둡니다.
  // 이 값이 없으면 도구가 예산을 다 쓰고 답변이 잘립니다(카드도 함께 줄어듦).
  // 하한은 **파생값에만** 겁니다.
  //   ANSWER_RESERVE_MS 를 REQUEST_BUDGET_MS 보다 크게 잘못 넣어도
  //   도구가 0초를 받지 않게 3초를 보장합니다.
  //   반대로 AGENT_BUDGET_MS 를 직접 0 으로 준 것은 의도이므로 존중합니다 —
  //   여기에 하한을 걸면 명시적 설정을 코드가 덮어쓰게 됩니다.
  const reserveBound = Math.max(startedAt + 3000, requestDeadlineAt - config.limits.answerReserveMs);
  const toolDeadlineAt = Math.min(startedAt + config.limits.agentBudgetMs, reserveBound);

  const accumulate = (turn) => {
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.totalTokens += turn.usage.totalTokens;
    if (turn.text) finalText += turn.text;
    // 어시스턴트가 만든 블록(텍스트 + toolUse)을 히스토리에 그대로 추가해야
    // 다음 턴에서 toolResult와 짝이 맞습니다.
    if (turn.assistantContent.length) {
      messages.push({ role: 'assistant', content: turn.assistantContent });
    }
  };

  /** 도구 결과를 모델에 아직 돌려주지 않은 상태인지 */
  let awaitingToolResults = false;

  for (let iteration = 0; iteration < config.limits.maxToolIterations; iteration += 1) {
    const turn = await streamOneTurn({
      messages, emit, iteration, intent, deadlineAt: requestDeadlineAt, replyLanguage,
    });
    accumulate(turn);

    if (turn.stopReason !== 'tool_use' || !turn.toolUses.length) {
      // 정상 종료
      awaitingToolResults = false;
      if (turn.stopReason === 'max_tokens') {
        emit({ type: 'notice', text: '(응답이 최대 길이에 도달해 잘렸습니다)' });
      }
      // stopReason === 'deadline' 이어도 사용자에게 알리지 않습니다.
      //
      // 전에는 "(시간이 부족해 여기서 마무리했습니다)" 를 띄웠습니다. 그런데
      // 이 문구는 카드 **뒤에** 렌더되어 답변을 다 읽은 뒤 마지막에 나타났고,
      // 사용자는 내용이 잘렸다는 사실만 알게 되고 할 수 있는 일이 없었습니다.
      // 우리 쪽 예산 배분은 우리 사정입니다 — 프롬프트에도 내부 사정을
      // 노출하지 말라고 적어두었는데 코드가 그 원칙을 어기고 있었습니다.
      // 운영에는 아래 log.warn 으로 남습니다.
      if (turn.stopReason === 'deadline') {
        log.warn('답변 턴이 마감에 걸림 — 부분 답변으로 진행', {
          iteration, chars: turn.text.length,
        });
      }
      break;
    }

    const toolResults = await executeToolUses({
      toolUses: turn.toolUses,
      secrets,
      emit,
      bookMap,
      toolCalls,
      // 도구 라운드 마감.
      //
      // 전체 마감에서 **답변 생성 몫을 먼저 떼고** 남은 시간만 씁니다.
      // 전에는 agentBudgetMs(18초)와 전체 마감(26초) 중 이른 쪽이었는데,
      // 도구가 18초를 다 쓰면 답변에 8초만 남아 생성이 끊겼습니다.
      // 끊긴 답변은 언급하는 책이 줄어 카드까지 같이 줄어듭니다.
      deadlineAt: toolDeadlineAt,
    });

    // 반복 상한 또는 시간 예산 초과 → 이번이 마지막 검색입니다.
    // 예산 판정은 toolDeadlineAt 을 씁니다 — 답변 몫을 뗀 뒤의 실제 마감입니다.
    const hitIterationCap = iteration === config.limits.maxToolIterations - 1;
    const elapsed = Date.now() - startedAt;
    const outOfBudget = Date.now() >= toolDeadlineAt;
    const isFinalRound = hitIterationCap || outOfBudget;

    messages.push({
      role: 'user',
      content: isFinalRound ? [...toolResults, { text: FINALIZE_INSTRUCTION }] : toolResults,
    });
    awaitingToolResults = true;

    if (isFinalRound) {
      log.warn('검색 종료 — 답변 마무리로 전환', {
        reason: outOfBudget ? 'time_budget' : 'iteration_cap',
        iteration,
        elapsedMs: elapsed,
        toolBudgetMs: toolDeadlineAt - startedAt,
        answerReserveMs: config.limits.answerReserveMs,
      });
      // 사용자에게는 알리지 않습니다. 검색을 몇 번 돌렸는지는 우리 사정이고,
      // 답변 아래 안내로 띄우면 "무언가 실패했나" 로만 읽힙니다.
      break;
    }
  }

  // ★ 예전 버그: 반복 상한에 걸리면 마지막 도구 결과를 모델에 보내지 않고 끝냈습니다.
  //   외부 API 호출과 토큰을 쓰고 결과를 버렸고, 그 턴에 텍스트가 없었으면
  //   사용자는 답변 없이 책 카드만 보게 되었습니다.
  //   → 소비되지 않은 도구 결과가 있으면 마무리 턴을 한 번 더 돌립니다.
  if (awaitingToolResults) {
    try {
      const closing = await streamOneTurn({
        messages, emit, iteration: config.limits.maxToolIterations, intent,
        deadlineAt: requestDeadlineAt, replyLanguage,
      });
      accumulate(closing);
    } catch (err) {
      // 마무리 턴이 실패해도 이미 확보한 책 카드는 살립니다.
      log.error('마무리 턴 실패 — 지금까지의 결과로 응답', { err: err.message });
      if (!finalText.trim()) throw err;
    }
  }

  // ── 카드 선별 ────────────────────────────────────────────────
  // 답변에서 실제로 언급한 책만 카드로 내보냅니다.
  // 도구를 하나 더 만들어 LLM 에게 고르게 하는 방식은 버렸습니다 —
  // 반복 예산(3회)을 먹고, LLM 이 호출을 빼먹으면 무너집니다.
  // 이미 생성된 답변을 근거로 쓰면 추가 비용이 0 입니다.
  const answer = finalText.trim();
  const found = [...bookMap.values()];

  // ★ 보충 조회 — 답변에 나왔는데 카드가 없는 책을 따로 가져옵니다.
  //
  //   왜 필요한가: LLM 이 자기 지식으로 언급한 책이나, 검색어가 달라서
  //   도구가 못 찾은 책은 카드가 없습니다. 사용자에게는
  //   "추천했는데 카드가 없다" 로 보입니다.
  //
  //   답변에서 제목을 뽑아 없는 것만 제목·저자로 정확 조회합니다.
  //   답변은 이미 스트리밍으로 나갔으므로 사용자는 글을 읽고 있고,
  //   카드만 잠시 뒤에 붙습니다.
  const backfilled = await backfillMentioned({
    answer,
    have: found,
    secrets,
    emit,
    // ★ 마감을 startedAt 기준이 아니라 **지금** 기준으로 셉니다.
    //
    //   전에는 startedAt + agentBudgetMs + BACKFILL_BUDGET_MS (= 24초) 였습니다.
    //   그런데 마무리 Bedrock 턴이 그 시각을 넘겨 끝나는 날이 있어서,
    //   보충 조회가 시작될 때 이미 마감이 지나 있었습니다. 그러면
    //   "남은 시간 부족" 으로 조용히 생략되고, 답변에 나온 책에 카드가 안 붙습니다.
    //   카드 보장을 만들어놓고 예산 산술 때문에 잃던 자리입니다.
    //
    //   전체 요청 마감은 넘지 않습니다. 정말 시간이 없으면 생략되는 게 맞습니다 —
    //   답변을 잘라서 카드를 붙이는 건 더 나쁜 거래입니다.
    deadlineAt: Math.min(Date.now() + BACKFILL_BUDGET_MS, requestDeadlineAt),
  });
  for (const b of backfilled) {
    if (!bookMap.has(bookKey(b))) bookMap.set(bookKey(b), b);
  }

  const all = [...bookMap.values()];
  const selection = selectForCards({ answer, books: all });
  logSelection(selection, all.length);

  if (selection.books.length) {
    emit({ type: 'books', items: selection.books });
  }

  return {
    answer,
    books: selection.books,
    // 선별 전 전체 목록. 채팅 기록·진단에 쓰려고 함께 돌려줍니다.
    allBooks: all,
    selection: {
      reason: selection.reason,
      collapsed: selection.collapsed,
      dropped: selection.dropped,
      backfilled: backfilled.length,
    },
    usage,
    toolCalls,
  };
}

/**
 * 답변에 나왔지만 카드가 없는 책을 조회해서 채웁니다.
 *
 * `lookup_books` 도구를 재사용합니다 — 그 안에 소스 라우팅(국내/해외)과
 * 제목·저자 검증이 이미 들어 있습니다. 검증에 실패한 책은 버려지므로
 * 잘못된 책이 카드로 붙지 않습니다.
 *
 * 시간 예산을 따로 둡니다. 에이전트 예산(18초)을 다 쓴 뒤에 도는 단계라
 * API Gateway 통합 타임아웃(30초)까지 남은 여유만 씁니다.
 */
async function backfillMentioned({ answer, have, secrets, emit, deadlineAt }) {
  const missing = missingTitles(answer, have).slice(0, BACKFILL_MAX_ITEMS);
  if (!missing.length) return [];

  const remaining = deadlineAt - Date.now();
  if (remaining < 1500) {
    log.warn('보충 조회 생략 — 남은 시간 부족', { missing: missing.length, remainingMs: remaining });
    return [];
  }

  log.info('보충 조회 시작', { titles: missing.map((m) => m.title), remainingMs: remaining });
  emit({ type: 'tool_start', name: 'lookup_books', label: TOOL_LABELS.lookup_books ?? '책 정보 확인' });

  const t0 = Date.now();
  try {
    const result = await withDeadline(
      runTool('lookup_books', { items: missing }, secrets),
      remaining,
      () => ({ books: [] }),
    );
    const books = result?.books ?? [];
    emit({ type: 'tool_end', name: 'lookup_books', label: TOOL_LABELS.lookup_books ?? '책 정보 확인', count: books.length, ms: Date.now() - t0 });
    log.info('보충 조회 완료', { asked: missing.length, got: books.length, ms: Date.now() - t0 });
    return books;
  } catch (err) {
    // 보충은 부가 단계입니다. 실패해도 답변과 기존 카드는 그대로 나갑니다.
    log.warn('보충 조회 실패', { err: err.message });
    emit({ type: 'tool_end', name: 'lookup_books', label: TOOL_LABELS.lookup_books ?? '책 정보 확인', count: 0, ms: Date.now() - t0 });
    return [];
  }
}

/**
 * 도구들을 병렬 실행하고 toolResult 배열을 만든다.
 *
 * ⚠️ Promise.allSettled 를 쓰는 이유:
 *   예전에는 Promise.all 이었습니다. 그런데 Bedrock은
 *   "assistant 의 toolUse 각각에 대응하는 toolResult 가 반드시 있어야 한다"고 요구합니다.
 *   도구 하나에서 예외가 새어 나오면 Promise.all 이 전체를 reject 하고,
 *   toolResult 가 하나도 만들어지지 않아 다음 호출이 ValidationException 으로 죽습니다.
 *   실패해도 status:'error' toolResult 를 만들어 짝을 맞춰야 대화가 이어집니다.
 */
async function executeToolUses({ toolUses, secrets, emit, bookMap, toolCalls, deadlineAt }) {
  const settled = await Promise.allSettled(
    toolUses.map(async (tu) => {
      const label = TOOL_LABELS[tu.name] ?? tu.name;
      toolCalls.push(tu.name);
      emit({ type: 'tool_start', name: tu.name, label, input: tu.input });

      const t0 = Date.now();
      // ⚠️ 마감을 여기서 강제하는 이유:
      //   예산 검사를 라운드가 "끝난 뒤"에만 하면, 이미 시작된 라운드가
      //   얼마나 걸리는지는 통제되지 않습니다. 외부 API 3개가 모두 느린 날
      //   한 라운드가 12초를 쓰고, 그 뒤에야 예산 초과를 알아채서
      //   API Gateway 29초를 넘겨 504가 났습니다.
      //   → 남은 예산만큼만 기다리고, 넘으면 부분 결과 없이 넘어갑니다.
      const result = await withDeadline(
        runTool(tu.name, tu.input ?? {}, secrets),
        deadlineAt - Date.now(),
        () => {
          log.warn('도구 마감 초과 — 결과 없이 진행', { tool: tu.name, waitedMs: Date.now() - t0 });
          return {
            llmText: `도구 "${tu.name}" 가 제한 시간 내에 응답하지 않았습니다. 지금까지 확보한 정보로 답변하세요.`,
            books: [],
            meta: { error: 'deadline_exceeded' },
          };
        },
      );
      const ms = Date.now() - t0;

      // 책 카드는 LLM을 거치지 않고 프론트로 직행 (토큰 절약 + 즉시 렌더)
      if (result.books?.length) {
        for (const b of result.books) {
          if (!bookMap.has(bookKey(b))) bookMap.set(bookKey(b), b);
        }
        // ★ 여기서 카드를 바로 내보내지 않습니다.
        //
        //   예전에는 도구가 찾은 책을 즉시 emit 했습니다. 그래서 LLM 이 언급하지
        //   않은 책까지 전부 카드가 되었습니다. 실측: 카드 26장 중 23장이
        //   답변에 없는 책이었고, 「혼불」 한 작품이 6장을 차지했습니다.
        //
        //   답변이 끝난 뒤 present.mjs 가 언급된 책만 골라 내보냅니다.
        //   화면 순서(진행표시 → 답변 → 카드)와도 일치합니다.
      }

      emit({ type: 'tool_end', name: tu.name, label, count: result.books?.length ?? 0, ms });
      log.info('tool 완료', { tool: tu.name, count: result.books?.length ?? 0, ms, cached: result.meta?.cached });

      return {
        toolResult: {
          toolUseId: tu.toolUseId,
          content: [{ text: result.llmText }],
          status: result.meta?.error ? 'error' : 'success',
        },
      };
    }),
  );

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;

    const tu = toolUses[i];
    const reason = String(s.reason?.message ?? s.reason);
    log.error('도구 실행이 예외로 종료 — error toolResult 로 대체', { tool: tu.name, reason });
    emit({ type: 'tool_end', name: tu.name, label: TOOL_LABELS[tu.name] ?? tu.name, count: 0, ms: 0 });
    return {
      toolResult: {
        toolUseId: tu.toolUseId,
        content: [{ text: `도구 실행이 실패했습니다: ${reason}. 다른 검색어나 다른 도구로 시도하세요.` }],
        status: 'error',
      },
    };
  });
}

/**
 * 화면 중복 카드 방지용 키.
 *
 * 예전에는 `isbn13[0] || id` 였습니다. ISBN이 없는 소스(Gutenberg 등)는
 * 도구마다 id 가 달라서 같은 책이 카드로 두 번 나왔습니다.
 * 제목+저자 기반 fuzzyKey 를 중간 폴백으로 끼웁니다.
 */
function bookKey(b) {
  return b.isbn13?.[0] || fuzzyKey(b.title, b.authors?.[0]) || b.id;
}

/**
 * promise 를 ms 밀리초까지만 기다린다. 초과하면 onTimeout() 값으로 대체.
 *
 * 진행 중인 작업을 취소하지는 못합니다(외부 fetch 는 자체 타임아웃이 있음).
 * 목적은 "응답을 제때 돌려주는 것"이지 리소스 회수가 아닙니다.
 */
function withDeadline(promise, ms, onTimeout) {
  // 이미 예산이 없으면 기다리지 않습니다.
  if (!(ms > 0)) {
    promise.catch(() => {}); // 미처리 rejection 경고 방지
    return Promise.resolve(onTimeout());
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * ConverseStream 한 턴을 소비하고 결과를 조립한다.
 */
async function streamOneTurn({
  messages, emit, iteration, intent = 'BOOK', deadlineAt = 0, replyLanguage = 'ko',
}) {
  const command = new ConverseStreamCommand({
    modelId: config.bedrock.modelId,
    // 언어 지시를 **맨 끝**에 둡니다. 근접성 때문입니다 — 앞쪽 불릿 한 줄로는
    // 한국어 도구 결과와 한국어 프롬프트의 무게를 이기지 못했습니다(실측).
    system: [{ text: SYSTEM_PROMPT + intentDirective(intent) + languageDirective(replyLanguage) }],
    messages,
    // ⚠️ temperature 와 topP 를 동시에 지정하지 않습니다.
    //
    // Anthropic 문서: "You should either alter temperature or top_p, but not both."
    // 일부 최신 Claude 모델(추론 지원 세대)은 Bedrock Converse에서 두 값을 함께
    // 보내면 ValidationException 을 반환합니다.
    // 원인 추적이 어려운 오류라 아예 topP 를 보내지 않습니다.
    inferenceConfig: {
      maxTokens: config.bedrock.maxTokens,
      temperature: config.bedrock.temperature,
    },
    toolConfig,
  });

  const t0 = Date.now();

  // ★ Bedrock 턴에도 마감을 겁니다.
  //
  //   전에는 이 호출과 아래 스트림 소비 루프가 무제한이었습니다. 도구 라운드만
  //   withDeadline 으로 묶고 LLM 턴은 열어둔 셈이라, Bedrock 이 느린 날
  //   통합 타임아웃(30초)을 넘겨 504 가 났고 사용자는 아무것도 못 받았습니다.
  //
  //   Promise.race 로 처리하지 않는 이유: 그러면 이미 받은 텍스트를 버립니다.
  //   AbortSignal 로 실제 스트림을 끊고, 그때까지 모은 블록은 살려서 돌려줍니다.
  //   잘린 답변이라도 있는 편이 빈 화면보다 낫고, 카드 선별도 그걸 쓸 수 있습니다.
  const controller = new AbortController();
  const remaining = deadlineAt ? deadlineAt - Date.now() : 0;
  let aborted = false;
  const timer = remaining > 0
    ? setTimeout(() => {
        aborted = true;
        controller.abort();
      }, remaining)
    : null;

  if (deadlineAt && remaining <= 0) {
    // 이미 마감을 넘겼습니다. 호출하지 않고 빈 턴을 돌려줍니다.
    log.warn('bedrock 턴 생략 — 마감 초과', { iteration });
    return { text: '', assistantContent: [], toolUses: [], stopReason: 'deadline', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  let response;
  try {
    response = await bedrock.send(command, { abortSignal: controller.signal });
  } catch (err) {
    if (timer) clearTimeout(timer);
    throw enrichBedrockError(err);
  }

  /** contentBlockIndex -> { type:'text', text } | { type:'toolUse', toolUseId, name, inputJson } */
  const blocks = new Map();
  let stopReason = 'end_turn';
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let text = '';
  let firstTokenMs = null;

  try {
  for await (const chunk of response.stream) {
    // ── 콘텐츠 블록 시작 (toolUse는 여기서 name/id를 받는다) ──
    if (chunk.contentBlockStart) {
      const idx = chunk.contentBlockStart.contentBlockIndex ?? 0;
      const tu = chunk.contentBlockStart.start?.toolUse;
      if (tu) {
        blocks.set(idx, { type: 'toolUse', toolUseId: tu.toolUseId, name: tu.name, inputJson: '' });
      }
      continue;
    }

    // ── 델타 ─────────────────────────────────────────────────
    if (chunk.contentBlockDelta) {
      const idx = chunk.contentBlockDelta.contentBlockIndex ?? 0;
      const delta = chunk.contentBlockDelta.delta ?? {};

      if (typeof delta.text === 'string' && delta.text.length) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        const prev = blocks.get(idx);
        if (prev?.type === 'text') prev.text += delta.text;
        else blocks.set(idx, { type: 'text', text: delta.text });

        text += delta.text;
        emit({ type: 'delta', text: delta.text });
        continue;
      }

      // toolUse의 input은 JSON 문자열이 조각조각 흘러온다 → 이어붙여서 마지막에 파싱
      if (delta.toolUse?.input !== undefined) {
        const b = blocks.get(idx);
        if (b?.type === 'toolUse') b.inputJson += delta.toolUse.input;
      }
      continue;
    }

    if (chunk.messageStop) {
      stopReason = chunk.messageStop.stopReason ?? 'end_turn';
      continue;
    }

    if (chunk.metadata?.usage) {
      usage.inputTokens = chunk.metadata.usage.inputTokens ?? 0;
      usage.outputTokens = chunk.metadata.usage.outputTokens ?? 0;
      usage.totalTokens = chunk.metadata.usage.totalTokens ?? 0;
      continue;
    }

    // 스트림 도중 발생하는 예외들
    const streamErr =
      chunk.internalServerException ||
      chunk.modelStreamErrorException ||
      chunk.validationException ||
      chunk.throttlingException ||
      chunk.serviceUnavailableException;
    if (streamErr) {
      throw Object.assign(new Error(streamErr.message || 'Bedrock 스트림 오류'), {
        name: 'BedrockStreamError',
      });
    }
  }
  } catch (err) {
    // 마감으로 우리가 끊은 경우 — 여기까지 모은 것으로 계속 진행합니다.
    if (aborted) {
      log.warn('bedrock 턴 마감 초과 — 부분 결과로 진행', {
        iteration,
        elapsedMs: Date.now() - t0,
        chars: text.length,
        toolUseStarted: [...blocks.values()].some((b) => b.type === 'toolUse'),
      });
      // 도구 호출이 반쯤 흘러온 상태면 그 블록은 쓸 수 없습니다.
      // 짝이 안 맞는 toolUse 를 히스토리에 넣으면 다음 호출이 ValidationException 입니다.
      for (const [idx, b] of [...blocks.entries()]) {
        if (b.type === 'toolUse') blocks.delete(idx);
      }
      stopReason = 'deadline';
    } else {
      throw err;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  // 블록을 인덱스 순으로 정렬해 assistant content 재구성
  const assistantContent = [];
  const toolUses = [];
  for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
    const b = blocks.get(idx);
    if (b.type === 'text') {
      if (b.text.trim()) assistantContent.push({ text: b.text });
    } else if (b.type === 'toolUse') {
      let input = {};
      try {
        input = b.inputJson ? JSON.parse(b.inputJson) : {};
      } catch (err) {
        log.warn('toolUse input JSON 파싱 실패', { name: b.name, raw: b.inputJson?.slice(0, 300) });
      }
      assistantContent.push({ toolUse: { toolUseId: b.toolUseId, name: b.name, input } });
      toolUses.push({ toolUseId: b.toolUseId, name: b.name, input });
    }
  }

  log.info('bedrock turn 완료', {
    iteration,
    stopReason,
    firstTokenMs,
    totalMs: Date.now() - t0,
    toolUses: toolUses.map((t) => t.name),
    ...usage,
  });

  return { text, assistantContent, toolUses, stopReason, usage };
}

/**
 * Bedrock 에러를 사람이 알아볼 수 있는 메시지로 바꾼다.
 * 실습에서 가장 자주 막히는 지점이라 힌트를 자세히 붙였습니다.
 */
function enrichBedrockError(err) {
  const name = err.name || '';
  const hints = {
    AccessDeniedException:
      `Bedrock 모델 접근이 거부되었습니다. 확인할 것: ` +
      `(1) Bedrock 콘솔 > "모델 액세스"에서 해당 모델이 "액세스 허용됨" 상태인지 ` +
      `(2) Lambda 실행 역할에 bedrock:InvokeModelWithResponseStream 권한이 있는지 ` +
      `(3) 리전이 맞는지 (현재: ${config.bedrock.region})`,
    ValidationException:
      `요청이 잘못되었습니다. 가장 흔한 원인은 modelId가 이 리전에서 유효하지 않은 것입니다. ` +
      `현재 modelId="${config.bedrock.modelId}", region="${config.bedrock.region}". ` +
      `확인할 것: (1) 접두사와 리전의 지역이 일치하는지 ` +
      `(us-east-1→us.*, ap-northeast-2→apac.*, 어디서나→global.*) ` +
      `(2) 레거시 모델이면 "-20250929-v1:0" 같은 버전 접미사가 끝에 붙어 있는지 ` +
      `(Claude Sonnet 4.6 이후 세대는 접미사가 없는 것이 정상입니다) ` +
      `Bedrock 콘솔 > 모델 카탈로그 > 모델 상세 > "Programmatic Access" 표에서 정확한 값을 확인하세요.`,
    ResourceNotFoundException:
      `modelId를 찾을 수 없습니다: "${config.bedrock.modelId}" (region=${config.bedrock.region}). ` +
      `모델 ID 오타 또는 리전 불일치입니다.`,
    ThrottlingException:
      `Bedrock 요청이 스로틀링되었습니다. 온디맨드 쿼터를 초과했습니다. ` +
      `잠시 후 재시도하거나 Service Quotas에서 한도 증가를 요청하세요.`,
  };

  const hint = hints[name];

  // ★ AWS의 실제 오류 메시지를 절대 버리지 않습니다.
  //
  //   예전에는 힌트로 메시지를 완전히 덮어썼는데, 그 때문에 실제 원인을
  //   찾는 데 오래 걸렸습니다. 예를 들어 ValidationException이 났을 때
  //   "modelId가 유효하지 않다"고 단정했지만, 실제로는 inferenceConfig의
  //   파라미터 조합 문제였습니다.
  //   힌트는 참고용이고, AWS 원문이 진실입니다. 둘 다 보여줍니다.
  const awsMessage = err.message || '(메시지 없음)';
  const composed = hint
    ? `[AWS ${name}] ${awsMessage}\n\n힌트: ${hint}`
    : `[AWS ${name}] ${awsMessage}`;

  log.error('Bedrock 호출 실패', {
    name,
    awsMessage,
    hint,
    // 요청 파라미터도 남겨서 무엇이 거부됐는지 추적 가능하게
    modelId: config.bedrock.modelId,
    bedrockRegion: config.bedrock.region,
    maxTokens: config.bedrock.maxTokens,
    temperature: config.bedrock.temperature,
  });

  return Object.assign(new Error(composed), { name, cause: err, userSafe: true });
}
