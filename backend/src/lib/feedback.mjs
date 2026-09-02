/**
 * 답변 평가 저장
 *
 * 왜 별도 항목이 아니라 기존 채팅 기록을 고치는가:
 *   평가를 따로 저장하면 나중에 "이 답변이 좋았나"를 알려고 두 곳을 대조해야 합니다.
 *   대신 이미 저장된 채팅 기록 항목에 속성을 덧붙이면,
 *   DynamoDB 콘솔에서 LOG#날짜 하나만 조회해도
 *   질문 · 답변 · 평가가 한 줄에 같이 보입니다. 검토가 목적이므로 이게 맞습니다.
 *
 * 왜 UpdateItem 인가:
 *   PutItem 은 항목을 통째로 덮어써서 질문·답변이 지워집니다.
 *   UpdateItem 은 지정한 속성만 더합니다.
 *
 * 조건부 쓰기(ConditionExpression)를 쓰는 이유:
 *   attribute_exists(pk) 를 걸어서 **이미 있는 기록에만** 평가를 붙입니다.
 *   이게 없으면 존재하지 않는 키로 요청이 와도 빈 항목이 새로 만들어져
 *   쓰레기 데이터가 쌓입니다.
 */

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { doc, TABLE } from './ddb.mjs';
import { parseLogRef } from './chatlog.mjs';
import { log } from './log.mjs';

/** 허용하는 평가 값. 이 두 개 외에는 받지 않습니다. */
const VERDICTS = new Set(['up', 'down']);

/** 자유 의견은 받되 길이를 제한합니다 (지금은 프론트에서 보내지 않음) */
const MAX_COMMENT = 500;

/**
 * @param {object} p
 * @param {unknown} p.logRef   프론트가 done 이벤트에서 받아 되보낸 값 (신뢰할 수 없음)
 * @param {unknown} p.verdict  'up' | 'down'
 * @param {unknown} [p.comment]
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function saveFeedback({ logRef, verdict, comment }) {
  // ── 1) 입력 검증 ────────────────────────────────────────────
  //
  // logRef 는 브라우저를 거쳐 돌아온 값입니다. 사용자가 바꿔 보낼 수 있습니다.
  // parseLogRef 가 형식을 엄격히 확인하고 LOG# 파티션만 통과시킵니다.
  // 이 검증이 없으면 SESSION#... 을 보내서 남의 대화 기록을 훼손할 수 있습니다.
  const key = parseLogRef(logRef);
  if (!key) {
    return { ok: false, status: 400, error: 'logRef 형식이 올바르지 않습니다.' };
  }

  if (!VERDICTS.has(verdict)) {
    return { ok: false, status: 400, error: "verdict 는 'up' 또는 'down' 이어야 합니다." };
  }

  const note = typeof comment === 'string' ? comment.trim().slice(0, MAX_COMMENT) : '';

  // ── 2) 저장 ─────────────────────────────────────────────────
  // 속성 이름을 한글로 두는 이유는 chatlog.mjs 와 같습니다 —
  // 콘솔에서 사람이 바로 읽을 수 있게 하려고.
  const names = {
    '#f': '평가',
    '#a': 'feedbackAt',
  };
  const values = {
    ':f': verdict === 'up' ? '좋음' : '아쉬움',
    ':a': new Date().toISOString(),
  };
  let expr = 'SET #f = :f, #a = :a';

  if (note) {
    names['#c'] = '의견';
    values[':c'] = note;
    expr += ', #c = :c';
  }

  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: key,
        UpdateExpression: expr,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        // 없는 기록에 평가를 붙이지 않습니다 (빈 항목 생성 방지)
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
    log.info('평가 저장', { verdict, pk: key.pk });
    return { ok: true };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // 기록이 없거나 이미 TTL 로 지워진 경우입니다.
      // 사용자 잘못이 아니므로 조용히 404 로 알립니다.
      log.warn('평가 대상 기록이 없음', { pk: key.pk });
      return { ok: false, status: 404, error: '평가할 기록을 찾을 수 없습니다.' };
    }
    log.error('평가 저장 실패', { err: err.message, name: err.name });
    return { ok: false, status: 500, error: '평가를 저장하지 못했습니다.' };
  }
}
