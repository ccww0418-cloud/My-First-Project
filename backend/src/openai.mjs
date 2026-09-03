/**
 * OpenAI-compatible Chat Completions 어댑터
 *
 *   POST /api/v1/chat/completions
 *
 * 목적: GuardBench 가 이 서비스를 **AI Application Target** 으로 호출할 수 있게
 * 합니다. 기존 /api/chat(SSE) 은 손대지 않았습니다. 이 파일은 HTTP 경계의
 * 번역기이고, 실제 판단은 전부 기존 모듈이 합니다
 * (policy.mjs → agent.mjs → tools/*).
 *
 * ────────────────────────────────────────────────────────────────
 * 계약 출처 (추측 아님, 소스 확인)
 *   저장소 : guardbench-backend @ origin/dev (f9f69f3)
 *   문서   : docs/integrations/http-endpoint-target.md
 *   구현   : src/main/java/com/guardbench/target/infrastructure/http/
 *              OpenAiCompatibleExecutionAdapter.java
 *              HttpEndpointHttpClient.java
 *              HttpEndpointProperties.java
 *   스키마 : docs/api/openapi.yaml  (TargetReferenceReq)
 *
 * GuardBench 가 보내는 것 — 정확히 이것뿐입니다:
 *   POST {target.identifier}
 *   Content-Type: application/json
 *   Accept: application/json
 *   {"model":"<target.model>","messages":[{"role":"user","content":"<input>"}]}
 *
 * GuardBench 가 읽는 것:
 *   choices[0].message.content   ← 문자열이어야 하고 blank 면 안 됩니다
 *
 * 그 밖의 필드(id·object·created·usage·finish_reason)는 허용되지만 필수가
 * 아닙니다. OpenAI 클라이언트 호환을 위해 함께 채웁니다.
 *
 * ★ 인증: GuardBench 는 **어떤 인증 정보도 보내지 못합니다.**
 *   - HttpEndpointHttpClient 가 붙이는 헤더는 Content-Type/Accept 둘뿐입니다.
 *   - Target 저장 스키마는 (reference_id, endpoint_url, model) 3열입니다.
 *   - openapi.yaml 의 TargetReferenceReq 는 additionalProperties: false 라
 *     키를 추가해 보낼 수도 없습니다.
 *   그래서 이 엔드포인트에는 API 키 검증을 두지 않습니다. 두면 401/403 이 되고
 *   GuardBench 는 TARGET_ACCESS_DENIED 로 기록합니다.
 *   보호는 (1) CloudFront 가 오리진으로 주입하는 x-origin-secret,
 *   (2) 아래 전용 레이트리밋, (3) WAF 가 담당합니다.
 *
 * ★ 구현하지 않은 것 (GuardBench 가 쓰지 않음):
 *   streaming/SSE, stream:true, tool/function calling, multimodal content,
 *   embeddings, /v1/responses, n>1, 대화 이력 유지.
 */

import { randomUUID } from 'node:crypto';

import { runAgent } from './agent.mjs';
import { config, getSecrets } from './lib/config.mjs';
import { evaluatePolicy, BLOCK, blockReason } from './lib/policy.mjs';
import { checkRateLimit } from './lib/ratelimit.mjs';
import { log } from './lib/log.mjs';

/** 레이트리밋 카운터를 채팅과 분리하는 파티션 키 접두사 */
const RATE_LIMIT_PREFIX = 'RLOAI';

/**
 * 허용 model 목록.
 *
 * 이 서비스는 Bedrock 모델 하나만 씁니다. model 로 라우팅하지는 않지만
 * 아무 값이나 받아 조용히 무시하지는 않습니다 — GuardBench 는 model 을
 * 실행 조건으로 고정 저장하므로, 오설정이 조용히 통과하면 나중에 어떤
 * 모델로 측정한 결과인지 알 수 없게 됩니다.
 */
export function supportedModels() {
  return [
    config.openai.modelAlias,
    config.bedrock.modelId,
    ...config.openai.extraModels,
  ].filter(Boolean);
}

export function isSupportedModel(model) {
  return supportedModels().includes(String(model ?? '').trim());
}

/**
 * OpenAI 오류 응답 형식.
 * GuardBench 는 본문을 읽지 않고 상태코드만 봅니다(4xx/5xx 분기).
 * 사람이 curl 로 원인을 알 수 있게 OpenAI 규약을 따릅니다.
 */
function errorPayload(message, type, code) {
  return { error: { message, type, code, param: null } };
}

/**
 * 요청 검증.
 *
 * @returns {{status:number, payload:object} | {model:string, message:string}}
 */
export function validateChatCompletionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      payload: errorPayload('요청 본문이 JSON 객체가 아닙니다.', 'invalid_request_error', 'invalid_body'),
    };
  }

  // ── model ────────────────────────────────────────────────
  // GuardBench 는 model 을 항상 보냅니다(어댑터가 blank 면 아예 호출조차
  // 하지 않고 TARGET_CONFIGURATION_INVALID 로 끝냅니다). 그래도 다른
  // 클라이언트를 위해 여기서도 확인합니다.
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) {
    return {
      status: 400,
      payload: errorPayload('model 필드가 필요합니다.', 'invalid_request_error', 'missing_model'),
    };
  }
  if (!isSupportedModel(model)) {
    return {
      status: 400,
      payload: errorPayload(
        `지원하지 않는 model 입니다: ${model}. 사용 가능한 값: ${supportedModels().join(', ')}`,
        'invalid_request_error',
        'model_not_found',
      ),
    };
  }

  // ── messages ─────────────────────────────────────────────
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      status: 400,
      payload: errorPayload(
        'messages 는 비어 있지 않은 배열이어야 합니다.',
        'invalid_request_error',
        'invalid_messages',
      ),
    };
  }

  // 스트리밍은 지원하지 않습니다. 조용히 무시하면 클라이언트가 SSE 를
  // 기다리다 멈추므로 명시적으로 거절합니다.
  if (body.stream === true) {
    return {
      status: 400,
      payload: errorPayload(
        'stream 은 지원하지 않습니다. 이 엔드포인트는 완성된 JSON 만 반환합니다.',
        'invalid_request_error',
        'stream_not_supported',
      ),
    };
  }

  // ★ 마지막 user 메시지를 입력으로 씁니다.
  //   GuardBench 는 user 하나만 보내므로 이걸로 충분합니다.
  //   앞선 턴은 사용하지 않습니다 — 이 엔드포인트는 무상태입니다
  //   (세션·히스토리를 읽거나 쓰지 않습니다).
  let message = '';
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const m = body.messages[i];
    if (!m || typeof m !== 'object' || m.role !== 'user') continue;
    // content 가 배열이면 multimodal 입니다 — 지원하지 않습니다.
    // 문자열이 아닌 것을 String() 으로 억지 변환하면 "[object Object]" 가
    // 모델 입력으로 들어가 측정이 오염됩니다.
    if (typeof m.content !== 'string') {
      return {
        status: 400,
        payload: errorPayload(
          'messages[].content 는 문자열이어야 합니다. 이 엔드포인트는 multimodal content 를 지원하지 않습니다.',
          'invalid_request_error',
          'invalid_content_type',
        ),
      };
    }
    message = m.content.trim();
    break;
  }

  if (!message) {
    return {
      status: 400,
      payload: errorPayload(
        'role 이 user 인 메시지에 내용이 있어야 합니다.',
        'invalid_request_error',
        'missing_user_message',
      ),
    };
  }

  // 과길이는 채팅과 같은 상한을 씁니다. 여기만 다르게 두면 벤치마크가
  // 통과하는 입력이 실서비스에서 413 이 되어 측정이 어긋납니다.
  if (message.length > config.limits.maxMessageChars) {
    return {
      status: 400,
      payload: errorPayload(
        `메시지가 너무 깁니다. ${config.limits.maxMessageChars}자 이내여야 합니다.`,
        'invalid_request_error',
        'message_too_long',
      ),
    };
  }

  return { model, message };
}

/**
 * OpenAI Chat Completion 응답 조립.
 *
 * @param {object} p
 * @param {string} p.model    요청받은 model 을 그대로 되돌려줍니다(OpenAI 관례)
 * @param {string} p.content  ★ blank 면 안 됩니다. 호출부에서 먼저 확인합니다.
 */
export function toChatCompletion({ model, content, usage, finishReason = 'stop' }) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
    // BookBot 내부 이름(inputTokens…)과 OpenAI 이름(prompt_tokens…)이 다릅니다.
    // 번역은 이 경계에서만 합니다.
    usage: {
      prompt_tokens: usage?.inputTokens ?? 0,
      completion_tokens: usage?.outputTokens ?? 0,
      total_tokens: usage?.totalTokens ?? 0,
    },
  };
}

/**
 * POST /api/v1/chat/completions 본체.
 *
 * @param {object} p
 * @param {object} p.body  파싱된 요청 본문
 * @param {string} p.ip    레이트리밋용 클라이언트 IP
 * @returns {Promise<{status:number, payload:object}>}
 */
export async function handleChatCompletions({ body, ip }) {
  const t0 = Date.now();

  const v = validateChatCompletionRequest(body);
  if (v.status) return { status: v.status, payload: v.payload };

  const { model, message } = v;

  // ── 레이트리밋 (채팅과 분리된 카운터) ──────────────────────
  const rl = await checkRateLimit(ip, {
    keyPrefix: RATE_LIMIT_PREFIX,
    perMinute: config.openai.perMinute,
    perDay: config.openai.perDay,
  });
  if (!rl.allowed) {
    log.warn('openai 엔드포인트 레이트리밋', { ip, reason: rl.reason });
    return {
      status: 429,
      payload: errorPayload(rl.reason, 'rate_limit_error', 'rate_limit_exceeded'),
      headers: rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : undefined,
    };
  }

  // ── 정책 검사 — /api/chat, /api/guard 와 **같은 모듈** ─────
  // 분리하면 "벤치마크는 통과하는데 실서비스는 안 막히는" 상태가 되어
  // 측정 자체가 무의미해집니다.
  const policy = await evaluatePolicy(message);

  // ★ 차단은 HTTP 오류가 아니라 **200 + 거절 문구**입니다.
  //
  //   GuardBench 문서: "Application 실행에서는 ALLOW 나 BLOCK 을 만들지
  //   않는다. 그 판정은 Evaluator Adapter 의 책임이다."
  //
  //   즉 우리는 "이 애플리케이션이 무엇이라고 답했는가"만 돌려주고,
  //   그 답이 적절한 거절인지는 GuardBench 의 Evaluator 가 판단합니다.
  //   여기서 4xx 를 주면 TARGET_CONFIGURATION_INVALID 가 되어
  //   "우리 서비스가 잘못 설정됐다" 로 기록되고, 정작 안전하게 거절했다는
  //   사실은 측정에서 사라집니다.
  if (policy.action === BLOCK) {
    const refusal = blockReason(policy.code);
    log.info('openai 엔드포인트 정책 차단', {
      code: policy.code, layer: policy.layer, intent: policy.intent, ms: policy.ms, ip,
    });
    return {
      status: 200,
      payload: toChatCompletion({
        model,
        content: refusal,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        // 정책으로 멈춘 것을 stop 이라고 하면 구분이 안 됩니다.
        // OpenAI 규약에 content_filter 가 있어 그대로 씁니다.
        finishReason: 'content_filter',
      }),
    };
  }

  // ── 모델 호출 ────────────────────────────────────────────
  let result;
  try {
    const secrets = await getSecrets();
    result = await runAgent({
      userMessage: message,
      history: [],          // 무상태 — 이 엔드포인트는 대화 이력을 쓰지 않습니다
      secrets,
      emit: () => {},       // SSE 가 없으므로 이벤트를 버립니다
      intent: policy.intent,
      // GuardBench 기본 타임아웃 15초보다 먼저 끝나야 합니다.
      budgetMs: config.openai.budgetMs,
    });
  } catch (err) {
    // ★ 모델 호출 실패를 200 으로 감싸지 않습니다.
    //   감싸면 GuardBench 가 오류 문구를 "모델의 답변" 으로 오인해
    //   안전성 평가에 넣습니다.
    log.error('openai 엔드포인트 모델 호출 실패', { err: err?.message, name: err?.name });
    return {
      status: 502,
      payload: errorPayload(
        err?.userSafe ? err.message : '모델 호출에 실패했습니다.',
        'api_error',
        'upstream_error',
      ),
    };
  }

  const content = typeof result?.answer === 'string' ? result.answer.trim() : '';

  // blank 응답도 실패입니다. GuardBench 는 blank content 를
  // PROVIDER_RESPONSE_INVALID 로 판정하므로 200 으로 내보내면 안 됩니다.
  // (예산 소진으로 한 글자도 못 만든 경우가 여기 걸립니다)
  if (!content) {
    log.error('openai 엔드포인트 빈 응답', { ms: Date.now() - t0, usage: result?.usage });
    return {
      status: 502,
      payload: errorPayload('모델이 빈 응답을 반환했습니다.', 'api_error', 'empty_response'),
    };
  }

  log.info('openai 엔드포인트 완료', {
    ip,
    model,
    totalMs: Date.now() - t0,
    answerChars: content.length,
    toolCalls: result.toolCalls,
    booksShown: result.books?.length ?? 0,
    ...result.usage,
  });

  return {
    status: 200,
    payload: toChatCompletion({ model, content, usage: result.usage }),
  };
}
