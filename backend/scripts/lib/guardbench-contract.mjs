/**
 * GuardBench HTTP Endpoint Target 판정 로직 — **전사본**
 *
 * 우리 기대가 아니라 상대 코드가 기준이어야 하므로, GuardBench 의 Java 구현을
 * 그대로 옮겼습니다. 우리 응답이 어떤 TargetFailureCode 로 기록될지 봅니다.
 *
 * 전사 출처 (guardbench-backend @ origin/dev, 커밋 f9f69f3)
 *   src/main/java/com/guardbench/target/infrastructure/http/
 *     HttpEndpointHttpClient.java            statusFailure() isJson() readBoundedBody()
 *     OpenAiCompatibleExecutionAdapter.java   execute() normalizeResponse()
 *     HttpEndpointProperties.java             DEFAULT_REQUEST_TIMEOUT_MS 등
 *
 * ⚠️ GuardBench 쪽 구현이 바뀌면 이 파일도 함께 고쳐야 합니다.
 *    바꿀 때는 위 파일들을 다시 읽고 맞추세요. 추측으로 고치면 이 파일의
 *    존재 이유(상대 기준으로 검증)가 사라집니다.
 */

/** HttpEndpointProperties 의 기본값 */
export const GB_DEFAULTS = {
  connectTimeoutMs: 5_000,
  requestTimeoutMs: 15_000,
  maxResponseBytes: 1_048_576,
};

/** HttpEndpointHttpClient.statusFailure() — null 이면 성공 */
export function statusFailure(status) {
  if (status === 404) return 'TARGET_NOT_FOUND';
  if (status === 401 || status === 403) return 'TARGET_ACCESS_DENIED';
  if (status >= 400 && status < 500) return 'TARGET_CONFIGURATION_INVALID';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status < 200 || status >= 300) return 'PROVIDER_RESPONSE_INVALID';
  return null;
}

/**
 * HttpEndpointHttpClient.isJson()
 * Java: response.headers().firstValue("Content-Type")
 *         .map(v -> v.toLowerCase(ROOT).startsWith("application/json")).orElse(false)
 * → 헤더가 없으면 false (= PROVIDER_RESPONSE_INVALID)
 */
export function isJson(contentType) {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith('application/json');
}

/**
 * OpenAiCompatibleExecutionAdapter.normalizeResponse()
 * @returns {{response:string} | {failureCode:string, why:string}}
 */
export function normalizeResponse(bodyText) {
  let root;
  try {
    root = JSON.parse(bodyText);
  } catch {
    return { failureCode: 'PROVIDER_RESPONSE_INVALID', why: 'malformed JSON' };
  }
  // Java: root == null || !root.isObject() → 실패
  const rootIsObject = root !== null && typeof root === 'object' && !Array.isArray(root);
  const choices = rootIsObject ? root.choices : null;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { failureCode: 'PROVIDER_RESPONSE_INVALID', why: 'choices 가 배열이 아니거나 비어 있음' };
  }
  const first = choices[0];
  const firstIsObject = first !== null && typeof first === 'object' && !Array.isArray(first);
  const message = firstIsObject ? first.message : null;
  const messageIsObject = message !== null && typeof message === 'object' && !Array.isArray(message);
  const content = messageIsObject ? message.content : null;
  // Java: content.isTextual() && !content.asText().isBlank()
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { failureCode: 'PROVIDER_RESPONSE_INVALID', why: 'content 가 문자열이 아니거나 blank' };
  }
  return { response: content };
}

/**
 * GuardBench 가 TestCase 한 건을 실행할 때 벌어지는 일 전체.
 *
 * @param {object} p
 * @param {string} p.url        target.identifier
 * @param {string} p.model      target.model
 * @param {string} p.input      TestCaseSnapshot.input
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{response?:string, failureCode?:string, why?:string,
 *                    ms:number, status?:number, bytes?:number}>}
 */
export async function executeAsGuardBench({ url, model, input, timeoutMs = GB_DEFAULTS.requestTimeoutMs }) {
  // OpenAiCompatibleExecutionAdapter.execute() — 본문은 정확히 이 두 필드
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: input }],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      // HttpRequest.newBuilder() 가 붙이는 헤더는 이 둘뿐입니다.
      // Authorization·API 키·커스텀 헤더는 보내지 않습니다.
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      redirect: 'manual', // 3xx 는 statusFailure 에서 PROVIDER_RESPONSE_INVALID
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return { failureCode: 'PROVIDER_TIMEOUT', why: `${timeoutMs}ms 초과`, ms };
    }
    return { failureCode: 'PROVIDER_UNAVAILABLE', why: `transport: ${err?.message}`, ms };
  }
  clearTimeout(timer);
  const ms = Date.now() - t0;

  const sf = statusFailure(res.status);
  if (sf) return { failureCode: sf, why: `HTTP ${res.status}`, ms, status: res.status };

  const contentType = res.headers.get('content-type');
  if (!isJson(contentType)) {
    return {
      failureCode: 'PROVIDER_RESPONSE_INVALID',
      why: `Content-Type=${contentType}`, ms, status: res.status,
    };
  }

  const text = await res.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) {
    return { failureCode: 'PROVIDER_RESPONSE_INVALID', why: '빈 본문', ms, status: res.status };
  }
  if (bytes > GB_DEFAULTS.maxResponseBytes) {
    return {
      failureCode: 'PROVIDER_RESPONSE_INVALID',
      why: `본문 ${bytes}B > ${GB_DEFAULTS.maxResponseBytes}B`, ms, status: res.status,
    };
  }

  return { ...normalizeResponse(text), ms, status: res.status, bytes };
}
