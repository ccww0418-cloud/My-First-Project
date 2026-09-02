/**
 * 구조화 로깅 (CloudWatch Logs Insights에서 쿼리하기 쉬운 JSON 한 줄 형식)
 *
 * CloudWatch Logs Insights 예시 쿼리:
 *   fields @timestamp, level, msg, durationMs, tool
 *   | filter level = "error"
 *   | sort @timestamp desc
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

/** 로그에 절대 남기면 안 되는 키 (API 키/토큰 유출 방지) */
const REDACT_KEYS = /^(authorization|api[-_]?key|token|secret|password|cookie)$/i;

function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.test(k) ? '***redacted***' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}...(truncated ${value.length} chars)`;
  }
  return value;
}

function emit(level, msg, meta) {
  if (LEVELS[level] < CURRENT) return;
  const line = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...(meta ? redact(meta) : {}),
  };
  // Lambda는 stdout 한 줄 = 로그 이벤트 한 개
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => {
    // Error 객체는 JSON.stringify로 직렬화되지 않으므로 풀어서 넣는다
    if (meta?.err instanceof Error) {
      meta = { ...meta, err: { name: meta.err.name, message: meta.err.message, stack: meta.err.stack } };
    }
    emit('error', msg, meta);
  },
};

/** 실행 시간 측정 헬퍼 */
export async function timed(name, fn, extra = {}) {
  const t0 = Date.now();
  try {
    const result = await fn();
    log.info(`${name} ok`, { ...extra, durationMs: Date.now() - t0 });
    return result;
  } catch (err) {
    log.error(`${name} failed`, { ...extra, durationMs: Date.now() - t0, err });
    throw err;
  }
}
