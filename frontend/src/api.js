/**
 * 백엔드 통신 (SSE 스트리밍 클라이언트)
 *
 * 왜 EventSource를 안 쓰는가:
 *   EventSource는 GET만 지원합니다. 채팅 메시지는 길어질 수 있어 POST 본문으로 보내야 합니다.
 *   그래서 fetch + ReadableStream을 직접 파싱합니다.
 *
 * 이 모듈은 두 가지 응답 형태를 모두 처리합니다:
 *   1) text/event-stream  → 스트리밍 (Lambda RESPONSE_STREAM)
 *   2) application/json   → 버퍼 응답 (Lambda BUFFERED / API Gateway)
 *      이 경우 events 배열을 순차 재생해서 UI 코드가 동일하게 동작하게 만듭니다.
 *   덕분에 백엔드 구성을 바꿔도 프론트를 고칠 필요가 없습니다.
 */

import { translate, getLang } from './i18n.js';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

const url = (path) => `${API_BASE}/api${path}`;

/** 세션 ID를 sessionStorage에 보관 (탭을 닫으면 사라짐 = 프라이버시에 유리) */
const SESSION_KEY = 'bookbot.sessionId';

export function getSessionId() {
  try {
    return sessionStorage.getItem(SESSION_KEY) || null;
  } catch {
    return null; // 시크릿 모드 등에서 sessionStorage 접근이 막힐 수 있음
  }
}

export function setSessionId(id) {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    /* 무시 */
  }
}

export function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* 무시 */
  }
}

/**
 * 예시 질문 등 초기 설정을 백엔드에서 가져온다 (실패해도 앱은 동작).
 * lang 을 넘겨야 백엔드가 해당 언어의 제안 문구를 돌려줍니다.
 * 이걸 빼면 UI가 영어인데 칩만 한국어로 나옵니다.
 */
export async function fetchConfig(lang = getLang()) {
  try {
    const res = await fetch(url(`/config?lang=${encodeURIComponent(lang)}`), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    // maxMessageChars 를 0 으로 두면 Composer 가 자기 기본값을 씁니다.
    // 여기서 숫자를 또 적으면 상한이 세 곳에 흩어집니다.
    return { suggestions: [], maxMessageChars: 0 };
  }
}

/**
 * 답변 평가 전송.
 *
 * logRef 는 done 이벤트에서 받은 값을 그대로 되보냅니다.
 * 프론트는 그 안에 무엇이 들었는지 알 필요가 없습니다 (백엔드가 해석).
 *
 * 실패해도 예외를 던지지 않습니다. 평가는 부가 기능이고,
 * 이것 때문에 대화가 끊기면 안 됩니다.
 *
 * @returns {Promise<boolean>} 저장 성공 여부
 */
export async function sendFeedback({ logRef, verdict }) {
  if (!logRef || !verdict) return false;
  try {
    const res = await fetch(url('/feedback'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logRef, verdict }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 배포 진단용 헬스체크 */
export async function fetchHealth() {
  const res = await fetch(url('/health'), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 채팅 요청 + 스트리밍 수신.
 *
 * @param {object} params
 * @param {string} params.message
 * @param {string|null} params.sessionId
 * @param {(event: object) => void} params.onEvent  백엔드 SSE 이벤트 콜백
 * @param {AbortSignal} [params.signal]             중단용
 */
export async function streamChat({ message, sessionId, onEvent, signal }) {
  const res = await fetch(url('/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message, sessionId: sessionId || undefined }),
    signal,
  });

  // ── HTTP 레벨 오류 ─────────────────────────────────────
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || body.error || '';
    } catch {
      /* 본문이 JSON이 아님 */
    }
    onEvent({
      type: 'error',
      code: res.status === 429 ? 'rate_limited' : `http_${res.status}`,
      message: detail || httpErrorMessage(res.status),
    });
    return;
  }

  const contentType = res.headers.get('content-type') || '';

  // ── 폴백: 버퍼 JSON 응답을 스트리밍처럼 재생 ──────────────
  if (contentType.includes('application/json')) {
    const body = await res.json();
    for (const e of body.events ?? []) onEvent(e);
    if (!body.events && body.answer) {
      onEvent({ type: 'delta', text: body.answer });
      onEvent({ type: 'done', sessionId: body.sessionId });
    }
    return;
  }

  // ── SSE 파싱 ──────────────────────────────────────────
  if (!res.body) {
    onEvent({ type: 'error', message: translate('err.noStream') });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE는 빈 줄(\n\n)로 이벤트를 구분합니다
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of raw.split('\n')) {
          // ':' 로 시작하는 줄은 주석(keep-alive). 무시합니다.
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onEvent(JSON.parse(payload));
          } catch {
            // 조각난 JSON은 건너뜁니다 (정상적으로는 발생하지 않음)
          }
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

function httpErrorMessage(status) {
  if (status === 403) return translate('err.403');
  if (status === 404) return translate('err.404');
  if (status === 413) return translate('err.413');
  if (status === 429) return translate('err.429');
  if (status === 502 || status === 504) return translate('err.5xx');
  return translate('err.default', { status });
}
