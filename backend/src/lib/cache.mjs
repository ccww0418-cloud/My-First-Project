/**
 * 외부 API 응답 캐시 (DynamoDB + TTL)
 *
 * 왜 필요한가:
 *  1) Hardcover는 분당 60회 제한, Google Books는 일 1000회 무료 쿼터.
 *     캐시가 없으면 데모 중에 쿼터가 말라버립니다.
 *  2) 같은 질문("추리소설 추천")이 반복되는 챗봇 특성상 히트율이 꽤 높습니다.
 *  3) 응답 속도: 외부 API 400~1500ms → DynamoDB 5~15ms
 *
 * 캐시 실패는 절대 요청을 실패시키지 않습니다 (fail-open).
 */

import { createHash } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { doc, TABLE, ttlFromNow } from './ddb.mjs';
import { config } from './config.mjs';
import { log } from './log.mjs';

function cacheKey(namespace, input) {
  const h = createHash('sha256')
    .update(`${namespace}::${JSON.stringify(input)}`)
    .digest('hex')
    .slice(0, 32);
  return `CACHE#${namespace}#${h}`;
}

/**
 * 캐시 우선 조회 후 미스면 producer 실행.
 *
 * @template T
 * @param {string} namespace     예: 'googleBooks.search'
 * @param {any} input            캐시 키를 만들 입력 (직렬화 가능해야 함)
 * @param {() => Promise<T>} producer
 * @param {number} [ttlSeconds]
 * @returns {Promise<{ value: T, cached: boolean }>}
 */
export async function withCache(namespace, input, producer, ttlSeconds = config.limits.cacheTtlSeconds) {
  const pk = cacheKey(namespace, input);

  try {
    const res = await doc.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk, sk: 'V1' },
        ProjectionExpression: 'payload',
      }),
    );
    if (res.Item?.payload) {
      log.debug('cache hit', { namespace });
      return { value: JSON.parse(res.Item.payload), cached: true };
    }
  } catch (err) {
    log.warn('cache read 실패 (무시하고 진행)', { namespace, err: err.message });
  }

  const value = await producer();

  // 쓰기는 기다리지 않고 백그라운드로 (응답 지연 방지)
  // 단, Lambda는 응답 후 실행이 멈출 수 있으므로 void가 아니라 catch만 붙여 fire-and-forget
  doc
    .send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk,
          sk: 'V1',
          namespace,
          payload: JSON.stringify(value),
          ttl: ttlFromNow(ttlSeconds),
        },
      }),
    )
    .catch((err) => log.warn('cache write 실패 (무시)', { namespace, err: err.message }));

  return { value, cached: false };
}
