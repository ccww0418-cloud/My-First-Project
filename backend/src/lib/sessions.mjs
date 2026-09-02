/**
 * 대화 세션 저장/조회 (DynamoDB, TTL 24시간)
 *
 * 저장 정책 — 왜 텍스트 턴만 저장하는가:
 *   Bedrock Converse는 "toolUse가 담긴 assistant 메시지 뒤에는 반드시 대응하는
 *   toolResult가 담긴 user 메시지가 와야 한다"는 제약이 있습니다.
 *   toolUse/toolResult를 그대로 저장하면 히스토리를 자를 때 이 짝이 깨져서
 *   ValidationException이 발생합니다.
 *   그래서 히스토리에는 순수 텍스트 턴만 남깁니다. 도구 결과는 어차피 매 요청마다
 *   새로 조회하는 게 정확하므로 손실도 없습니다. (부수 효과로 토큰도 절약)
 */

import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { doc, TABLE, ttlFromNow } from './ddb.mjs';
import { config } from './config.mjs';
import { log } from './log.mjs';

const MAX_CHARS_PER_TURN = 4000;

export function newSessionId() {
  return randomUUID();
}

/** 세션 ID 형식 검증 (임의 문자열로 다른 파티션을 긁지 못하게) */
export function isValidSessionId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

/**
 * @param {string} sessionId
 * @returns {Promise<Array<{role:'user'|'assistant', content:[{text:string}]}>>}
 */
export async function loadHistory(sessionId) {
  if (!isValidSessionId(sessionId)) return [];
  try {
    const res = await doc.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk: `SESSION#${sessionId}`, sk: 'META' },
        ProjectionExpression: 'messages',
      }),
    );
    const messages = res.Item?.messages;
    if (!Array.isArray(messages)) return [];
    return sanitize(messages);
  } catch (err) {
    log.warn('세션 로드 실패 (빈 히스토리로 진행)', { sessionId, err: err.message });
    return [];
  }
}

/**
 * @param {string} sessionId
 * @param {Array} messages  텍스트 전용 메시지 배열
 */
export async function saveHistory(sessionId, messages) {
  if (!isValidSessionId(sessionId)) return;
  const trimmed = clampTurns(sanitize(messages), config.limits.historyTurns);
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: `SESSION#${sessionId}`,
          sk: 'META',
          messages: trimmed,
          turnCount: trimmed.length,
          updatedAt: new Date().toISOString(),
          ttl: ttlFromNow(config.limits.sessionTtlSeconds),
        },
      }),
    );
  } catch (err) {
    // 저장 실패로 사용자 응답을 망치지 않는다
    log.warn('세션 저장 실패', { sessionId, err: err.message });
  }
}

/**
 * 뒤에서 max개만 남기되, 반드시 user 로 시작하게 자릅니다.
 *
 * 왜 필요한가: 예전에는 그냥 `.slice(-max)` 였습니다.
 *   뒤에서 자르면 결과가 assistant 로 시작할 수 있고, 그 상태로 저장됩니다.
 *   다음 요청에서 loadHistory → sanitize 가 맨 앞 assistant 를 shift 로 버리므로
 *   저장은 됐지만 실제로는 한 턴이 조용히 사라졌습니다.
 *   대화 맥락이 어긋나는 원인이었고 로그에도 안 남았습니다.
 */
function clampTurns(messages, max) {
  let out = messages.slice(-max);
  while (out.length && out[0].role !== 'user') out = out.slice(1);
  return out;
}

/**
 * 텍스트 블록만 남기고 길이를 제한. toolUse/toolResult 블록은 제거.
 * 또한 첫 메시지가 assistant이면 제거 (Bedrock은 user로 시작해야 함).
 */
export function sanitize(messages) {
  const out = [];
  for (const m of messages) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    const texts = (m.content ?? [])
      .filter((b) => typeof b?.text === 'string' && b.text.trim())
      .map((b) => ({ text: b.text.slice(0, MAX_CHARS_PER_TURN) }));
    if (!texts.length) continue;

    // 같은 role이 연속되면 병합 (Bedrock은 role 교대를 요구)
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content.push(...texts);
    } else {
      out.push({ role: m.role, content: texts });
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}
