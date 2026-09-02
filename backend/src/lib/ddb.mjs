/**
 * DynamoDB 클라이언트 (단일 테이블 설계)
 *
 * 테이블: bookbot
 *   파티션 키 pk (String), 정렬 키 sk (String), TTL 속성 ttl
 *
 * | 용도        | pk                  | sk                | 비고                  |
 * |------------|---------------------|-------------------|----------------------|
 * | 대화 세션   | SESSION#<uuid>      | META              | messages 리스트       |
 * | 응답 캐시   | CACHE#<sha256(16)>  | V1                | payload JSON 문자열    |
 * | 레이트리밋  | RL#<ip>             | <윈도우 epoch>     | count (원자적 ADD)     |
 *
 * DocumentClient를 쓰는 이유: { S: "..." } 같은 AttributeValue 래핑을 직접 안 해도 됨.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

const base = new DynamoDBClient({
  region: REGION,
  maxAttempts: 3,
});

export const doc = DynamoDBDocumentClient.from(base, {
  marshallOptions: {
    removeUndefinedValues: true, // undefined 속성은 자동 제거 (안 하면 에러남)
    convertClassInstanceToMap: true,
  },
});

export const TABLE = process.env.TABLE_NAME || 'bookbot';

/** 현재 시각 + n초를 epoch seconds로 (TTL 속성용) */
export function ttlFromNow(seconds) {
  return Math.floor(Date.now() / 1000) + seconds;
}
