/**
 * 외부 API 호출용 fetch 래퍼
 *
 * Node 22 내장 fetch(undici)를 사용합니다. 외부 HTTP 라이브러리 의존성 0.
 *
 * 담당하는 것:
 *  - 타임아웃 (AbortSignal) — Lambda가 외부 API 때문에 멈추지 않게
 *  - 재시도 (429 / 5xx / 네트워크 오류에 대해 지수 백오프 + 지터)
 *  - User-Agent 강제 — Open Library는 정체를 밝히지 않는 요청을 차단합니다
 *  - 응답 크기 제한 — 거대한 JSON이 Lambda 메모리를 먹지 않게
 */

import { log } from './log.mjs';

const DEFAULT_TIMEOUT = Number(process.env.EXTERNAL_API_TIMEOUT_MS || 5000);
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3MB

/**
 * 기본 재시도 횟수를 2 → 1 로 줄였습니다.
 *
 * 왜: API Gateway 통합 타임아웃이 30초입니다. 재시도 2회면
 *   시도 3회 × 6초 + 백오프(250 + 500ms) ≈ 19초를 한 소스가 혼자 쓸 수 있었습니다.
 *   도구를 두 번만 호출해도 30초를 넘겨 사용자에게 504가 갔습니다.
 *   재시도 1회 + 타임아웃 5초면 최악 ≈ 10.3초로 절반이 됩니다.
 *   소스가 3개 병렬이라 하나가 느려도 나머지로 답할 수 있으므로
 *   재시도를 줄이는 편이 전체 성공률에 유리합니다.
 */
const DEFAULT_RETRIES = Number(process.env.EXTERNAL_API_RETRIES || 1);

/**
 * Open Library / Gutendex 같은 커뮤니티 API는 연락처가 담긴 User-Agent를 요구합니다.
 * (익명 UA는 429나 403을 받을 수 있음)
 * 실제 배포 시 CONTACT_EMAIL 환경 변수로 본인 연락처를 넣어주세요.
 */
const CONTACT = process.env.CONTACT_EMAIL || 'bookbot-aws-workshop@example.com';
export const USER_AGENT = `BookBot/1.0 (AWS workshop project; ${CONTACT})`;

class HttpError extends Error {
  constructor(status, statusText, bodySnippet, url) {
    super(`HTTP ${status} ${statusText} — ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.url = url;
  }
}
export { HttpError };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * 응답 본문을 상한까지만 읽는다.
 *
 * 왜 res.text() 를 바로 쓰지 않는가:
 *   예전 코드는 content-length 헤더만 보고 3MB를 넘으면 거부했습니다.
 *   그런데 chunked 응답(Transfer-Encoding: chunked)에는 content-length 가 없습니다.
 *   그 경우 검사가 통째로 건너뛰어지고 res.text() 가 무제한으로 버퍼링했습니다.
 *   외부 API가 거대한 응답을 주면 Lambda가 메모리 부족으로 죽습니다.
 *   → 스트림을 직접 읽으면서 누적 바이트를 세고, 넘으면 즉시 끊습니다.
 */
async function readTextCapped(res, cap, url) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > cap) {
    throw new HttpError(res.status, 'Payload Too Large', '', url);
  }
  if (!res.body) return res.text();

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        throw new HttpError(res.status, 'Payload Too Large', '', url);
      }
      chunks.push(value);
    }
  } finally {
    // 상한 초과로 중단한 경우 남은 데이터를 계속 받지 않도록 연결을 끊습니다.
    try {
      await reader.cancel();
    } catch {
      /* 이미 닫혔으면 무시 */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * JSON을 반환하는 HTTP 요청.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers]
 * @param {any}    [opts.body]            객체면 JSON.stringify 됨
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries=2]
 * @param {string} [opts.label]           로그용 이름
 * @returns {Promise<any>} 파싱된 JSON
 */
export async function fetchJson(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
    label = new URL(url).host,
  } = opts;

  const finalHeaders = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...headers,
  };

  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const t0 = Date.now();

    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: controller.signal,
      });

      const text = await readTextCapped(res, MAX_BODY_BYTES, url);

      if (!res.ok) {
        const err = new HttpError(res.status, res.statusText, text.slice(0, 500), url);
        if (isRetryable(res.status) && attempt < retries) {
          lastErr = err;
          // 429면 Retry-After를 존중
          const retryAfter = Number(res.headers.get('retry-after'));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 4000)
            : 250 * 2 ** attempt + Math.random() * 200;
          log.warn('http retry', { label, status: res.status, attempt, backoffMs: Math.round(backoff) });
          await sleep(backoff);
          continue;
        }
        throw err;
      }

      log.debug('http ok', { label, status: res.status, durationMs: Date.now() - t0, bytes: text.length });

      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${label}: 응답이 JSON이 아님 (${text.slice(0, 200)})`);
      }
    } catch (err) {
      lastErr = err;
      const isAbort = err.name === 'AbortError';
      const isNetwork = err.name === 'TypeError' || err.cause?.code;

      if ((isAbort || isNetwork) && attempt < retries) {
        const backoff = 250 * 2 ** attempt + Math.random() * 200;
        log.warn('http retry (network)', { label, attempt, reason: err.name, backoffMs: Math.round(backoff) });
        await sleep(backoff);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 쿼리스트링을 안전하게 붙인다 (undefined/null/'' 은 제외) */
export function buildUrl(base, params = {}) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}
