/**
 * 설정 로딩
 *
 * - 일반 설정: Lambda 환경 변수
 * - 비밀 값(API 키): SSM Parameter Store SecureString
 *
 * 왜 Secrets Manager가 아니라 SSM인가:
 *   표준 파라미터는 무료(Secrets Manager는 시크릿당 $0.40/월). 2주 실습에는 SSM이 합리적.
 *   자동 로테이션이 필요한 운영 환경이라면 Secrets Manager를 쓰세요.
 *
 * 왜 모듈 스코프 캐시인가:
 *   Lambda 실행 환경(컨테이너)은 재사용됩니다. 매 요청마다 SSM을 호출하면
 *   불필요한 지연(30~60ms)과 API 호출 요금이 발생합니다. 5분 TTL로 캐싱합니다.
 */

import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { log } from './log.mjs';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const SSM_PREFIX = process.env.SSM_PREFIX || '/bookbot/prod';
const SECRET_TTL_MS = 5 * 60 * 1000;

const ssm = new SSMClient({ region: REGION, maxAttempts: 3 });

/** @type {{ values: Record<string,string>, expiresAt: number } | null} */
let secretCache = null;

/**
 * 마지막 SSM 조회 결과를 기록해둡니다.
 * /api/health 가 "왜 키를 못 읽었는지"를 응답에 담아 보여주기 위한 진단용입니다.
 * (실습에서 가장 많이 막히는 지점이라, 로그를 안 봐도 원인을 알 수 있게 만듭니다)
 */
export const ssmDiagnostics = {
  lastAttemptAt: null,
  ok: false,
  errorName: null,
  errorMessage: null,
  foundParameterNames: [],
};

/**
 * SSM_PREFIX 아래의 모든 파라미터를 읽어 { NAME: value } 로 반환.
 * 로컬 테스트에서는 셸 환경 변수를 폴백으로 사용합니다.
 */
export async function getSecrets() {
  if (secretCache && secretCache.expiresAt > Date.now()) {
    return secretCache.values;
  }

  // 로컬 스모크 테스트용 폴백
  if (process.env.BOOKBOT_LOCAL === '1') {
    const local = {
      GOOGLE_BOOKS_API_KEY: process.env.GOOGLE_BOOKS_API_KEY || '',
      HARDCOVER_TOKEN: process.env.HARDCOVER_TOKEN || '',
      ALADIN_TTB_KEY: process.env.ALADIN_TTB_KEY || '',
      NLK_API_KEY: process.env.NLK_API_KEY || '',
    };
    secretCache = { values: local, expiresAt: Date.now() + SECRET_TTL_MS };
    return local;
  }

  const values = {};
  let nextToken;
  const t0 = Date.now();

  try {
    do {
      const res = await ssm.send(
        new GetParametersByPathCommand({
          Path: SSM_PREFIX,
          Recursive: true,
          WithDecryption: true,
          MaxResults: 10,
          NextToken: nextToken,
        }),
      );
      for (const p of res.Parameters ?? []) {
        // /bookbot/prod/GOOGLE_BOOKS_API_KEY -> GOOGLE_BOOKS_API_KEY
        const key = p.Name.slice(p.Name.lastIndexOf('/') + 1);
        values[key] = p.Value;
      }
      nextToken = res.NextToken;
    } while (nextToken);

    log.info('secrets loaded', {
      prefix: SSM_PREFIX,
      keys: Object.keys(values), // 값은 절대 로그에 남기지 않음
      durationMs: Date.now() - t0,
    });

    Object.assign(ssmDiagnostics, {
      lastAttemptAt: new Date().toISOString(),
      ok: true,
      errorName: null,
      errorMessage: null,
      foundParameterNames: Object.keys(values),
    });

    if (!Object.keys(values).length) {
      log.warn('SSM 조회는 성공했지만 파라미터가 0개입니다', {
        prefix: SSM_PREFIX,
        region: REGION,
        hint: `이 리전(${REGION})의 Parameter Store에 ${SSM_PREFIX}/ 경로로 파라미터를 만들었는지 확인하세요. 다른 리전에 만들었으면 여기서는 보이지 않습니다.`,
      });
    }
  } catch (err) {
    log.error('SSM 파라미터 로딩 실패', { prefix: SSM_PREFIX, region: REGION, err });
    Object.assign(ssmDiagnostics, {
      lastAttemptAt: new Date().toISOString(),
      ok: false,
      errorName: err.name || 'Error',
      errorMessage: err.message,
      foundParameterNames: [],
    });
    // 키 없이도 동작하는 API(Open Library, Gutendex)는 살려두기 위해 throw 하지 않음
    // -> "부분 실패 허용" 전략
  }

  secretCache = { values, expiresAt: Date.now() + SECRET_TTL_MS };
  return values;
}

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  region: REGION,
  ssmPrefix: SSM_PREFIX,

  bedrock: {
    region: process.env.BEDROCK_REGION || REGION,
    // ⚠️ 기본값을 두지 않습니다.
    //
    // 예전에는 'apac.anthropic.claude-sonnet-4-5-...'를 기본값으로 뒀는데,
    // 환경 변수가 비어 있을 때 이 값이 조용히 들어가서
    // "us-east-1에 apac. 접두사" 같은 잘못된 조합을 만들었습니다.
    // 실제로 이 때문에 원인 파악이 늦어졌습니다.
    //
    // 값이 없으면 /api/health의 problems에 명시적으로 보고되고,
    // 호출 시에도 즉시 실패합니다. 조용히 틀린 값을 쓰는 것보다 낫습니다.
    modelId: process.env.BEDROCK_MODEL_ID || '',
    // 3072 인 이유: 추천을 10권 이상 하도록 바꾸면서 답변이 길어졌습니다.
    // 한국어는 글자당 토큰 소모가 커서 1400자 답변이 2048 토큰을 넘깁니다.
    // 2048 이던 동안에는 stopReason=max_tokens 로 답변이 중간에 잘렸고,
    // 잘린 답변은 카드 선별(답변 텍스트에서 제목을 뽑음)까지 같이 망칩니다.
    // 상한을 올려도 실제로 생성한 토큰만 과금되므로 비용은 늘지 않습니다.
    maxTokens: num('BEDROCK_MAX_TOKENS', 3072),
    temperature: num('BEDROCK_TEMPERATURE', 0.4),
  },

  ddb: {
    tableName: process.env.TABLE_NAME || 'bookbot',
  },

  limits: {
    perMinute: num('RATE_LIMIT_PER_MINUTE', 10),
    perDay: num('RATE_LIMIT_PER_DAY', 150),
    maxToolIterations: num('MAX_TOOL_ITERATIONS', 4),

    /**
     * 도구 루프에 허용하는 시간의 **상한**입니다. 넘기면 검색을 멈추고
     * 지금까지의 결과로 답변을 마무리합니다.
     *
     * ⚠️ 기본값에서 이 값은 동작하지 않습니다. 실제 도구 마감은
     *   requestBudgetMs - answerReserveMs 쪽이 항상 더 이릅니다:
     *
     *     requestDeadline = 시작 + 26,000
     *     reserveBound    = 시작 + 26,000 - 15,000  = 시작 + 11,000   ← 이게 이깁니다
     *     toolDeadline    = min(시작 + 18,000, 시작 + 11,000)
     *
     *   즉 **도구가 실제로 쓰는 시간은 11초**입니다. 전에 이 주석이
     *   "도구 라운드 최대 18초" 라고 적어두어 예산 계산을 두 번 틀리게 했습니다.
     *
     *   답변 몫을 조절하고 싶으면 ANSWER_RESERVE_MS 를 만지세요.
     *   이 값은 그보다 짧은 상한을 강제로 걸 때만 의미가 있습니다
     *   (테스트가 0 을 넣어 예산 초과 경로를 검증합니다).
     */
    agentBudgetMs: num('AGENT_BUDGET_MS', 18000),

    /**
     * 요청 전체의 마감. 도구·LLM·보충 조회를 **모두** 포함합니다.
     *
     * 왜 이게 따로 필요한가:
     *   agentBudgetMs 는 "도구 라운드"만 묶습니다. 그런데 Bedrock 턴 자체에는
     *   마감이 없었습니다. 위 18초 계산의 "마무리 Bedrock 턴 3~8초" 는
     *   주석에 적힌 가정일 뿐이고 코드로 강제되지 않았습니다.
     *   Bedrock 이 느린 날 그 턴이 15초를 쓰면 통합 타임아웃을 넘겨 504 가 났고,
     *   사용자는 답변을 한 글자도 못 받았습니다.
     *
     *   → 이 값이 모든 단계를 감싸는 하나의 벽입니다. 하위 예산은 이 안에 듭니다.
     *
     * 26초인 이유: API Gateway HTTP API 통합 타임아웃이 30초이고 이 값은
     *   증액할 수 없습니다(AWS 쿼터 문서: Maximum integration timeout 30s,
     *   Can be increased = No). 응답 직렬화·전송 여유로 4초를 남깁니다.
     *
     * 함수 URL(스트리밍) 로 돌아가면 이 벽이 Lambda 타임아웃 90초로 올라갑니다.
     * 그때는 환경 변수만 올리면 되고 코드는 그대로입니다.
     */
    requestBudgetMs: num('REQUEST_BUDGET_MS', 26000),

    /**
     * 최종 답변 생성에 **미리 떼어두는** 시간.
     *
     * 왜 필요한가 (실측):
     *   도구 예산 18초 + 답변 생성 16.7초 = 34.7초. 그런데 전체 예산은 26초입니다.
     *   도구가 18초를 다 쓰면 답변에 8초만 남아, 생성이 중간에 끊겼습니다.
     *   끊긴 답변은 언급하는 책이 줄고 → 카드도 줄어듭니다.
     *   실측 로그: outputTokens 1129, totalMs 16702 (초당 68토큰).
     *
     *   → 도구 라운드의 마감을 "전체 예산 - 이 값" 으로 앞당깁니다.
     *     도구를 조금 덜 돌더라도 답변을 온전히 쓰는 편이 낫습니다.
     *     후보는 이미 충분합니다 — 실측으로 18~40권이 들어옵니다.
     *
     * 15초인 이유: 실측 16.7초는 권당 125~225토큰을 쓰던 때의 값입니다.
     *   프롬프트를 "권당 한 줄" 로 바꿔 900토큰 안팎을 목표로 하므로 약 13초면 됩니다.
     *   여유를 조금 둡니다.
     */
    answerReserveMs: num('ANSWER_RESERVE_MS', 15000),

    maxMessageChars: 2000,
    historyTurns: 12,
    sessionTtlSeconds: 24 * 60 * 60,
    cacheTtlSeconds: num('CACHE_TTL_SECONDS', 6 * 60 * 60),
  },

  /**
   * 채팅 기록 보관 (검토용). 세션(24시간)과는 별개입니다.
   * 자세한 설명은 lib/chatlog.mjs 파일 위쪽 주석 참고.
   */
  chatLog: {
    enabled: process.env.CHAT_LOG_ENABLED !== '0',
    // 0 이면 TTL 없이 영구 보관
    ttlDays: num('CHAT_LOG_TTL_DAYS', 90),
    // 날짜 파티션을 자를 기준 시간대. 9 = 한국(KST)
    tzOffsetHours: num('CHAT_LOG_TZ_OFFSET_HOURS', 9),
    // IP 저장은 기본 꺼둡니다 (검토 목적에 불필요한 개인정보)
    saveIp: process.env.CHAT_LOG_SAVE_IP === '1',
  },

  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
