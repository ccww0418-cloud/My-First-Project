/**
 * 채팅 기록 보관 (검토용)
 *
 * 왜 세션(sessions.mjs)과 따로 두는가:
 *   세션은 **대화를 이어가기 위한** 데이터라 24시간 뒤 지워집니다.
 *   그게 맞습니다. 오래된 맥락을 모델에 넣으면 오히려 답이 나빠지고,
 *   개인정보를 필요 이상으로 갖고 있게 됩니다.
 *
 *   그런데 "내가 어떤 질문을 했고 봇이 뭐라 답했는지 나중에 검토"하려면
 *   따로 남겨야 합니다. 그래서 용도가 다른 항목을 하나 더 씁니다.
 *
 * 키 설계 — AWS 콘솔에서 코드 없이 보기 편하게:
 *   pk = LOG#2026-08-29          날짜 하나가 파티션 하나
 *   sk = 2026-08-29T07:12:33.101Z#a1b2c3d4    시간순 정렬
 *
 *   DynamoDB 콘솔 > 항목 탐색 > 쿼리 에서 파티션 키에
 *   LOG#2026-08-29 만 입력하면 그날 대화가 시간순으로 쭉 나옵니다.
 *   스캔이 아니라 쿼리라 빠르고 저렴합니다.
 *
 * 보관 기간:
 *   CHAT_LOG_TTL_DAYS 일 뒤 자동 삭제 (기본 90일).
 *   0 으로 두면 TTL 을 붙이지 않아 영구 보관합니다.
 *
 * 실패는 절대 사용자 응답을 망치지 않습니다 (fail-open).
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { doc, TABLE, ttlFromNow } from './ddb.mjs';
import { config } from './config.mjs';
import { log } from './log.mjs';

/** 답변이 아주 길 때 항목이 비대해지지 않도록 자릅니다 (DynamoDB 항목 상한 400KB) */
const MAX_TEXT = 8000;

/**
 * 날짜 파티션 문자열을 만든다.
 *
 * UTC 를 쓰지 않는 이유: 한국에서 "오늘 대화"를 찾을 때 UTC 기준이면
 * 오전 9시 이전 대화가 어제 파티션에 들어가 헷갈립니다.
 * CHAT_LOG_TZ_OFFSET_HOURS (기본 9 = 한국) 기준으로 날짜를 자릅니다.
 */
export function logDateKey(date = new Date(), offsetHours = config.chatLog.tzOffsetHours) {
  const shifted = new Date(date.getTime() + offsetHours * 3600 * 1000);
  return shifted.toISOString().slice(0, 10); // YYYY-MM-DD
}

const clip = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');

/**
 * 한 번의 주고받기를 기록한다.
 *
 * @param {object} p
 * @param {string}  p.sessionId
 * @param {string}  p.question   사용자 입력 원문
 * @param {string}  p.answer     봇 답변 (차단된 경우 차단 안내문)
 * @param {string[]} [p.bookTitles]  추천된 책 제목 (전체 레코드는 저장하지 않음)
 * @param {string[]} [p.toolCalls]
 * @param {object}  [p.usage]    { inputTokens, outputTokens }
 * @param {number}  [p.ms]
 * @param {boolean} [p.blocked]  정책으로 차단되었는지
 * @param {string}  [p.policyCode]
 * @param {string}  [p.ip]
 */
export async function appendChatLog(p) {
  if (!config.chatLog.enabled) return null;

  const now = new Date();
  const ts = now.toISOString();
  const shortSession = String(p.sessionId || 'unknown').slice(0, 8);

  const item = {
    pk: `LOG#${logDateKey(now)}`,
    // 같은 밀리초에 두 건이 들어와도 세션이 다르면 키가 겹치지 않습니다.
    sk: `${ts}#${shortSession}`,

    // ── 콘솔에서 눈으로 읽는 항목 (이 순서로 보면 편합니다) ──
    시각: new Date(now.getTime() + config.chatLog.tzOffsetHours * 3600 * 1000)
      .toISOString()
      .slice(11, 19),
    질문: clip(p.question),
    답변: clip(p.answer),
    추천도서: (p.bookTitles ?? []).slice(0, 10),

    // ── 분석용 ──
    sessionId: p.sessionId || '',
    blocked: Boolean(p.blocked),
    policyCode: p.policyCode || '',
    toolCalls: p.toolCalls ?? [],
    inputTokens: p.usage?.inputTokens ?? 0,
    outputTokens: p.usage?.outputTokens ?? 0,
    durationMs: p.ms ?? 0,
    ts,
  };

  // IP 는 기본으로 저장하지 않습니다. 검토 목적에 필요 없고 개인정보이기 때문입니다.
  // 남용 추적이 필요하면 CHAT_LOG_SAVE_IP=1 로 켜세요.
  if (config.chatLog.saveIp && p.ip) item.ip = p.ip;

  // 0 이면 TTL 속성을 아예 넣지 않습니다 → 영구 보관
  if (config.chatLog.ttlDays > 0) {
    item.ttl = ttlFromNow(config.chatLog.ttlDays * 24 * 60 * 60);
  }

  try {
    await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
    // 저장된 위치를 돌려줍니다. 프론트가 이 값을 그대로 되보내면
    // "이 답변이 좋았다/아니었다"를 **같은 항목에** 기록할 수 있습니다.
    return buildLogRef(item.pk, item.sk);
  } catch (err) {
    log.warn('채팅 기록 저장 실패 (응답에는 영향 없음)', { err: err.message });
    // 기록이 실패했으면 평가를 붙일 대상이 없습니다. null 을 주면
    // 프론트가 피드백 버튼을 아예 표시하지 않습니다.
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// 피드백을 붙일 위치를 가리키는 문자열 (logRef)
// ────────────────────────────────────────────────────────────────
//
// 왜 pk 와 sk 를 한 문자열로 합치는가:
//   프론트엔드는 DynamoDB 를 몰라야 합니다. 두 개의 키를 따로 들고 다니게 하면
//   나중에 저장 구조를 바꿀 때 프론트까지 고쳐야 합니다.
//   불투명한 한 덩어리로 주고받으면 백엔드 안에서만 해석하면 됩니다.
//
// ⚠️ 이 값은 브라우저를 거쳐 돌아오므로 **사용자가 조작할 수 있습니다.**
//   검증 없이 그대로 쓰면 SESSION#... 이나 CACHE#... 항목을 고칠 수 있습니다.
//   그래서 parseLogRef 가 형식을 엄격히 확인하고 LOG# 파티션만 허용합니다.

/** pk 와 sk 를 하나의 불투명 문자열로 */
export function buildLogRef(pk, sk) {
  return `${pk}::${sk}`;
}

/**
 * logRef 를 검증하고 pk/sk 로 되돌립니다.
 * 형식이 조금이라도 어긋나면 null 을 반환합니다 (허용하지 않습니다).
 *
 *   허용:  LOG#2026-08-30::2026-08-30T07:56:00.725Z#a1b2c3d4
 *   거부:  SESSION#...   CACHE#...   LOG#../..   과도하게 긴 값 등
 *
 * @param {unknown} raw
 * @returns {{pk: string, sk: string} | null}
 */
export function parseLogRef(raw) {
  if (typeof raw !== 'string') return null;
  // 길이 상한 — 비정상적으로 긴 입력을 정규식에 넣지 않습니다.
  if (raw.length > 80) return null;

  // pk = LOG#YYYY-MM-DD
  // sk = ISO8601(밀리초까지)#세션앞8자(16진수)
  const m = /^(LOG#\d{4}-\d{2}-\d{2})::(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[0-9a-f]{1,8})$/.exec(raw);
  if (!m) return null;

  return { pk: m[1], sk: m[2] };
}
