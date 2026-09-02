/**
 * IP 기반 레이트리밋 (DynamoDB 원자적 카운터)
 *
 * 왜 이게 이 프로젝트에서 가장 중요한 코드인가:
 *   Lambda Function URL은 API Gateway와 달리 내장 스로틀링이 없습니다.
 *   로그인도 없는 공개 엔드포인트 + Bedrock 호출 = 누가 스크립트로 돌리면 비용 폭탄.
 *   이 함수가 1차 방어선입니다. (2차는 WAF rate-based rule, 3차는 예약 동시성, 4차는 Budgets 알림)
 *
 * 방식:
 *   UpdateItem + ADD 는 DynamoDB에서 원자적입니다. 동시 요청에도 카운트가 정확합니다.
 *   분 단위 윈도우와 일 단위 윈도우를 각각 셉니다.
 *   TTL로 오래된 카운터는 자동 삭제 → 정리 코드 불필요.
 */

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { doc, TABLE, ttlFromNow } from './ddb.mjs';
import { config } from './config.mjs';
import { log } from './log.mjs';

/**
 * @param {string} ip
 * @returns {Promise<{ allowed: boolean, reason?: string, retryAfterSeconds?: number }>}
 */
export async function checkRateLimit(ip) {
  if (!ip) return { allowed: true };

  const now = Math.floor(Date.now() / 1000);
  const minuteWindow = Math.floor(now / 60) * 60;
  const dayWindow = Math.floor(now / 86400) * 86400;

  const bump = async (sk, ttlSeconds) => {
    const res = await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `RL#${ip}`, sk },
        UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
        ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttlFromNow(ttlSeconds) },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return Number(res.Attributes?.count || 0);
  };

  try {
    const [perMinute, perDay] = await Promise.all([
      bump(`MIN#${minuteWindow}`, 120),
      bump(`DAY#${dayWindow}`, 86400 + 3600),
    ]);

    if (perMinute > config.limits.perMinute) {
      log.warn('rate limit hit (minute)', { ip, perMinute });
      return {
        allowed: false,
        reason: `요청이 너무 빠릅니다. 분당 ${config.limits.perMinute}회까지 가능합니다.`,
        retryAfterSeconds: minuteWindow + 60 - now,
      };
    }
    if (perDay > config.limits.perDay) {
      log.warn('rate limit hit (day)', { ip, perDay });
      return {
        allowed: false,
        reason: `일일 사용 한도(${config.limits.perDay}회)에 도달했습니다. 내일 다시 시도해 주세요.`,
        retryAfterSeconds: dayWindow + 86400 - now,
      };
    }
    return { allowed: true };
  } catch (err) {
    // DynamoDB 장애 시 서비스를 죽이지 않고 통과시킴 (fail-open).
    // 비용이 더 중요하면 fail-closed(차단)로 바꾸세요.
    log.error('rate limit 검사 실패 — 통과 처리', { ip, err });
    return { allowed: true };
  }
}

/**
 * 이벤트에서 실제 클라이언트 IP 추출.
 *
 * CloudFront를 거치면 sourceIp는 CloudFront 엣지 IP가 되므로
 * X-Forwarded-For의 첫 번째 값을 우선합니다.
 *
 * 폴백은 세 형식을 모두 봅니다 — 게이트웨이를 바꿀 때 조용히 빈 문자열이
 * 되면 레이트리밋이 통째로 무력화됩니다(`checkRateLimit` 은 ip 가 비면 통과).
 *   · payload 2.0 (HTTP API / 함수 URL) → requestContext.http.sourceIp
 *   · payload 1.0 (REST API)           → requestContext.identity.sourceIp
 */
export function clientIpFrom(event) {
  const xff = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return (
    event.requestContext?.http?.sourceIp
    || event.requestContext?.identity?.sourceIp
    || ''
  );
}
