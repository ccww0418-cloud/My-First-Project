/**
 * Lambda 엔트리포인트
 *
 * 두 가지 핸들러를 export 합니다:
 *   handler          — 스트리밍 (Function URL, 호출 모드 RESPONSE_STREAM) ★ 권장
 *   bufferedHandler  — 비스트리밍 (API Gateway 또는 호출 모드 BUFFERED)
 *
 * Lambda 콘솔의 "핸들러" 값:
 *   src/index.handler          (스트리밍)
 *   src/index.bufferedHandler  (버퍼)
 *
 * 라우팅 (CloudFront가 /api/* 를 이 함수로 보냅니다):
 *   GET  /api/health   헬스체크 + 설정 진단
 *   GET  /api/config   프론트가 쓸 예시 질문 등
 *   POST /api/chat     채팅 (SSE 스트리밍)
 *   POST /api/guard    GuardBench 정책 판정 ({input} → {action})
 *   POST /api/feedback 답변 평가 접수
 *   POST /api/v1/chat/completions
 *                      OpenAI 호환 Chat Completions — GuardBench 가 이 서비스를
 *                      AI Application Target 으로 호출하는 경로 (openai.mjs).
 *                      경로에 /api 를 붙여둔 이유: CloudFront 캐시 비헤이비어와
 *                      API Gateway 라우트가 /api/* 만 이 Lambda 로 보냅니다.
 *                      /v1/... 을 루트에 노출하려면 인프라 변경이 필요합니다.
 *   OPTIONS *          CORS 프리플라이트
 *
 * SSE 이벤트 스펙 (프론트 src/api.js와 짝을 맞춰야 함):
 *   {"type":"session","sessionId":"..."}
 *   {"type":"tool_start","name":"search_books","label":"...","input":{...}}
 *   {"type":"books","items":[{...}]}
 *   {"type":"tool_end","name":"...","count":8,"ms":1234}
 *   {"type":"delta","text":"안녕"}
 *   {"type":"notice","text":"..."}
 *   {"type":"done","usage":{...},"toolCalls":[...]}
 *   {"type":"error","message":"...","code":"..."}
 */

import { runAgent } from './agent.mjs';
import { config, getSecrets, ssmDiagnostics } from './lib/config.mjs';
import { evaluatePolicy, ALLOW, BLOCK, blockReason } from './lib/policy.mjs';
import { log } from './lib/log.mjs';
import { checkRateLimit, clientIpFrom } from './lib/ratelimit.mjs';
import { loadHistory, saveHistory, newSessionId, isValidSessionId } from './lib/sessions.mjs';
import { appendChatLog } from './lib/chatlog.mjs';
import { saveFeedback } from './lib/feedback.mjs';
import { suggestionsFor } from './prompt.mjs';
import { handleChatCompletions } from './openai.mjs';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform이 중요합니다. 없으면 중간 프록시가 버퍼링해서 스트리밍이 깨질 수 있습니다.
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// ────────────────────────────────────────────────────────────────
// 라우팅 공통
// ────────────────────────────────────────────────────────────────

function parseRequest(event) {
  const method = event?.requestContext?.http?.method ?? event?.httpMethod ?? 'GET';
  const rawPath = event?.rawPath ?? event?.path ?? '/';
  // CloudFront가 /api/chat 그대로 넘기므로 /api 접두사를 벗겨서 비교
  const path = rawPath.replace(/^\/api/, '') || '/';
  let body = null;
  if (event?.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }
  return { method, path, body, headers: event?.headers ?? {} };
}

/**
 * 오리진 비밀 헤더 검증 — 함수 URL 직접 호출 차단
 *
 * 왜 이 방식인가 (중요):
 *   원래는 함수 URL 인증을 AWS_IAM으로 두고 CloudFront OAC가 SigV4 서명하게 했습니다.
 *   그런데 AWS 문서에 명시된 제약이 있습니다:
 *
 *     "If you use PUT or POST methods with your Lambda function URL, your users must
 *      compute the SHA256 of the body and include the payload hash value in the
 *      x-amz-content-sha256 header. Lambda doesn't support unsigned payloads."
 *
 *   즉 본문이 있는 POST는 **브라우저(뷰어)가** 본문 해시를 계산하고 SigV4 서명까지 해야
 *   합니다. 공개 웹앱에서는 불가능합니다. GET /api/health는 본문이 없어 통과하지만
 *   POST /api/chat은 403이 됩니다.
 *
 *   그래서 함수 URL 인증을 NONE으로 바꾸고, CloudFront가 오리진으로만 보내는
 *   커스텀 헤더로 인증합니다. 이 헤더는 브라우저에 노출되지 않습니다.
 *
 * 보안 특성:
 *   - 값은 SSM SecureString에 보관 (ORIGIN_SECRET)
 *   - 헤더가 없거나 틀리면 403. 함수 URL을 알아도 호출 불가
 *   - 타이밍 공격 방지를 위해 길이 비교 후 상수 시간 비교
 *   - ORIGIN_SECRET이 설정되지 않은 경우는 검증을 건너뜁니다(로컬 개발/마이그레이션 호환)
 */
function checkOriginSecret(headers, secrets) {
  const expected = secrets?.ORIGIN_SECRET || '';
  if (!expected) return { ok: true, skipped: true };

  const provided = headers['x-origin-secret'] || headers['X-Origin-Secret'] || '';
  if (!provided) return { ok: false, reason: 'missing' };

  // 상수 시간 비교
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: 'mismatch' };
}

function corsHeaders(originHeader) {
  // CloudFront 단일 오리진 구성이면 CORS가 필요 없습니다(same-origin).
  // ALLOWED_ORIGINS를 설정한 경우(로컬 개발 등)에만 헤더를 붙입니다.
  if (!config.allowedOrigins.length) return {};
  const origin = originHeader || '';
  const allowed = config.allowedOrigins.includes(origin) ? origin : config.allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * UI 언어 판별 — /config 의 예시 질문 언어를 정하는 데만 씁니다.
 *
 * 우선순위: ?lang= 쿼리 → Accept-Language 헤더 → 영어.
 * 챗봇 **답변** 언어는 이 값과 무관합니다. 그건 모델이 사용자 입력을 보고 정합니다.
 */
function langFrom(event) {
  const q = event?.queryStringParameters?.lang || event?.rawQueryString?.match(/(?:^|&)lang=([^&]+)/)?.[1];
  if (q) return decodeURIComponent(q);

  const al = event?.headers?.['accept-language'] || event?.headers?.['Accept-Language'] || '';
  // "ko-KR,ko;q=0.9,en;q=0.8" → "ko"
  const first = String(al).split(',')[0].trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(first) ? first : 'en';
}

/**
 * GET /api/config 응답.
 *
 * maxMessageChars 를 함께 내려보내는 이유:
 *   프론트 Composer 가 같은 값을 상수로 들고 있었습니다(MAX_CHARS = 2000).
 *   주석으로 "백엔드와 동일하게 유지" 라고만 적혀 있어서, 백엔드에서 상한을
 *   바꾸면 조용히 어긋납니다. 그러면 입력창은 더 받아주는데 서버가 413 으로
 *   거절하거나(사용자는 이유를 모름), 반대로 입력창이 먼저 잘라서 서버 상한을
 *   못 쓰게 됩니다. 서버가 진실을 알려주고 프론트가 따르게 합니다.
 *
 * 스트리밍 핸들러와 버퍼 핸들러 두 곳에서 같은 응답을 만들어야 하므로
 * 함수로 뽑았습니다. 전에는 두 곳에 각각 적혀 있어 한쪽만 고칠 위험이 있었습니다.
 */
function configPayload(event) {
  return {
    suggestions: suggestionsFor(langFrom(event)),
    maxMessageChars: config.limits.maxMessageChars,
  };
}

/** 채팅 요청 검증. 문제가 있으면 { error, status } 반환 */
function validateChat(body) {
  if (!body || typeof body !== 'object') {
    return { error: '요청 본문이 JSON이 아닙니다.', status: 400 };
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return { error: 'message 필드가 필요합니다.', status: 400 };
  if (message.length > config.limits.maxMessageChars) {
    return { error: `메시지가 너무 깁니다. ${config.limits.maxMessageChars}자 이내로 입력해 주세요.`, status: 413 };
  }
  const sessionId = isValidSessionId(body.sessionId) ? body.sessionId : newSessionId();
  return { message, sessionId };
}

/**
 * DynamoDB에 실제로 접근이 되는지 확인한다.
 *
 * 왜 필요한가:
 *   기존 헬스체크는 환경 변수 TABLE_NAME 값만 보여줬습니다.
 *   테이블이 그 리전에 존재하는지, 권한이 있는지는 알 수 없었습니다.
 *   존재하지 않는 키를 GetItem 하면 정상 응답(Item 없음)이 오므로
 *   비용 없이 "테이블 존재 + 권한"을 한 번에 검증할 수 있습니다.
 *   (DescribeTable을 쓰면 IAM 권한을 추가해야 하므로 GetItem을 씁니다)
 */
async function probeDynamo() {
  const t0 = Date.now();
  try {
    const { doc, TABLE } = await import('./lib/ddb.mjs');
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: 'HEALTH#probe', sk: 'V1' } }));
    return { ok: true, table: TABLE, latencyMs: Date.now() - t0 };
  } catch (err) {
    const hints = {
      ResourceNotFoundException: `테이블 "${config.ddb.tableName}"이 리전 ${config.region}에 없습니다. 다른 리전에 만들었거나 이름이 다릅니다.`,
      AccessDeniedException: `IAM 실행 역할에 DynamoDB 권한이 없습니다. 정책의 Resource ARN 리전이 ${config.region}인지 확인하세요.`,
      ValidationException: '테이블의 키 스키마가 다릅니다. 파티션 키 pk(문자열) + 정렬 키 sk(문자열)이어야 합니다.',
    };
    return {
      ok: false,
      table: config.ddb.tableName,
      error: err.name,
      message: err.message,
      hint: hints[err.name],
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * 모델 ID 형식 분석.
 *
 * ⚠️ Bedrock 모델 ID 형식은 두 세대가 공존합니다:
 *
 *   레거시 (Claude Opus 4.6 이전)
 *     anthropic.claude-sonnet-4-5-20250929-v1:0     날짜 + 버전 접미사
 *     us.anthropic.claude-sonnet-4-5-20250929-v1:0
 *
 *   신형 (Claude Sonnet 4.6 이후) — 접미사가 없어졌습니다
 *     anthropic.claude-sonnet-4-6                   In-Region
 *     us.anthropic.claude-sonnet-4-6                Geo (US)
 *     global.anthropic.claude-sonnet-4-6            Global
 *
 * 그래서 "-vN:N이 없으면 잘못됨"으로 판정하면 최신 모델을 오탐합니다.
 * 확실히 깨진 경우(날짜는 있는데 버전 접미사가 없는 경우)만 문제로 보고,
 * 나머지는 정보성 안내만 합니다. 실제 유효성은 호출 시 Bedrock이 알려줍니다
 * (agent.mjs의 enrichBedrockError가 원인별 한국어 힌트를 붙입니다).
 */
function analyzeModelId(modelId, bedrockRegion) {
  const problems = [];

  if (!modelId) {
    problems.push('BEDROCK_MODEL_ID 환경 변수가 비어 있습니다. 채팅이 동작하지 않습니다.');
    return { problems, prefix: null, generation: null, valid: false };
  }

  // 지역 접두사 분리 (us. / eu. / apac. / au. / jp. / global.)
  const m = /^(us|eu|apac|au|jp|global)\.(.+)$/.exec(modelId);
  const prefix = m ? m[1] : null;
  const bare = m ? m[2] : modelId;

  const hasDate = /-\d{8}(-|$)/.test(bare);
  const hasVersion = /-v\d+:\d+$/.test(bare);

  // 확실히 깨진 조합: 날짜가 있는데 버전 접미사가 없음 (레거시 ID를 잘라 쓴 경우)
  if (hasDate && !hasVersion) {
    problems.push(
      `BEDROCK_MODEL_ID "${modelId}"는 날짜는 있는데 버전 접미사(-v1:0)가 없습니다. ` +
        `레거시 형식 모델은 "...-20250929-v1:0" 처럼 끝나야 합니다. ` +
        `Bedrock 콘솔 > 모델 카탈로그 > 모델 상세 > Programmatic Access 표에서 전체 문자열을 복사하세요.`,
    );
  }

  // 접두사와 리전의 지리적 정합성 (틀리면 ValidationException)
  const prefixRegionOk = {
    us: (r) => /^(us|ca)-/.test(r),
    eu: (r) => /^(eu|il|me|af)-/.test(r),
    apac: (r) => /^ap-/.test(r),
    au: (r) => /^ap-southeast-(2|4|6)$/.test(r),
    jp: (r) => /^ap-northeast-(1|3)$/.test(r),
    global: () => true,
  };
  if (prefix && prefixRegionOk[prefix] && !prefixRegionOk[prefix](bedrockRegion)) {
    problems.push(
      `모델 ID 접두사 "${prefix}."와 BEDROCK_REGION "${bedrockRegion}"의 지역이 맞지 않습니다. ` +
        `호출 시 ValidationException이 발생합니다. 접두사를 리전에 맞추거나 "global." 을 쓰세요.`,
    );
  }

  return {
    problems,
    prefix: prefix ?? '(없음 — In-Region)',
    generation: hasDate ? 'legacy(날짜+버전)' : 'modern(4.6+, 접미사 없음)',
    valid: problems.length === 0,
    // In-Region은 온디맨드 쿼터가 가장 낮습니다. 데모 중 스로틀링을 피하려면 Geo/Global 권장.
    note: prefix
      ? undefined
      : 'In-Region 추론입니다. 온디맨드 쿼터가 가장 낮아 스로틀링 위험이 있습니다. ' +
        `처리량이 필요하면 "us.${modelId}" 또는 "global.${modelId}" 를 쓰세요.`,
  };
}

/**
 * GuardBench 연동 엔드포인트
 *
 *   POST /api/guard
 *   Request  : { "input": "사용자 입력 문자열" }
 *   Response : { "action": "ALLOW" }  또는  { "action": "BLOCK" }
 *
 * ★ 응답 body에는 action 외의 필드를 절대 넣지 않습니다 (최소 계약).
 *   판정 이유는 X-Policy-Reason 헤더와 CloudWatch 로그로만 노출합니다.
 *   그래야 GuardBench 파서가 깨지지 않으면서도 디버깅이 가능합니다.
 *
 * 이 엔드포인트는 /api/chat 과 **동일한 정책 모듈**을 사용합니다.
 * 분리하면 "벤치마크는 통과하는데 실서비스는 안 막히는" 상태가 되어
 * 측정 자체가 무의미해집니다.
 */
async function handleGuard(body, ip) {
  const input = typeof body?.input === 'string' ? body.input : '';
  const verdict = await evaluatePolicy(input);

  log.info('policy 판정', {
    action: verdict.action,
    code: verdict.code,
    layer: verdict.layer,
    ms: verdict.ms,
    inputChars: input.length,
    ip,
  });

  return {
    // 계약: body는 action 하나만
    body: { action: verdict.action },
    headers: {
      'X-Policy-Reason': verdict.code,
      'X-Policy-Layer': verdict.layer,
    },
  };
}

/**
 * 답변 평가 접수 (POST /api/feedback)
 *
 * 두 핸들러(스트리밍·버퍼)가 같은 로직을 쓰도록 여기에 모았습니다.
 *
 * 보호 장치와 그 이유:
 *   1) 오리진 비밀 헤더 — CloudFront 를 거치지 않은 직접 호출을 막습니다.
 *   2) logRef 형식 검증 — feedback.mjs 가 LOG# 파티션만 허용합니다.
 *   3) 조건부 쓰기 — 실제로 존재하는 기록에만 붙습니다.
 *
 * 앱 레이트리밋(checkRateLimit)은 **일부러 걸지 않았습니다.**
 *   그 카운터는 채팅 횟수(분당 10회·하루 150회)와 같은 것을 씁니다.
 *   평가 버튼을 누를 때마다 채팅 할당량이 깎이면 사용자가 손해를 봅니다.
 *   평가는 DynamoDB UpdateItem 한 번이라 비용이 거의 없고,
 *   유효한 logRef 를 알아야 하므로 아무 값이나 넣어서는 통하지 않습니다.
 *   대량 호출은 WAF 레이트리밋(IP당 5분 300회)이 막습니다.
 */
async function handleFeedbackRequest(body, headers, ip) {
  const gate = checkOriginSecret(headers, await getSecrets());
  if (!gate.ok) {
    log.warn('평가 요청의 오리진 검증 실패', { reason: gate.reason, ip });
    return { status: 403, payload: { error: 'Forbidden' } };
  }

  const r = await saveFeedback({
    logRef: body?.logRef,
    verdict: body?.verdict,
    comment: body?.comment,
  });

  return r.ok
    ? { status: 200, payload: { ok: true } }
    : { status: r.status, payload: { error: r.error } };
}

async function healthPayload() {
  const [secrets, dynamo] = await Promise.all([getSecrets(), probeDynamo()]);

  const hasGoogle = Boolean(secrets.GOOGLE_BOOKS_API_KEY);
  const hasHardcover = Boolean(secrets.HARDCOVER_TOKEN);
  const hasAladin = Boolean(secrets.ALADIN_TTB_KEY);
  const hasNlk = Boolean(secrets.NLK_API_KEY);

  // ── 설정 문제를 사람이 읽을 수 있는 문장으로 모아준다 ──
  const problems = [];

  if (!dynamo.ok) {
    problems.push(`DynamoDB 접근 실패 (${dynamo.error}): ${dynamo.hint ?? dynamo.message}`);
  }

  if (!hasGoogle || !hasHardcover) {
    if (!ssmDiagnostics.ok) {
      problems.push(
        `SSM 조회 자체가 실패했습니다 (${ssmDiagnostics.errorName}): ${ssmDiagnostics.errorMessage}` +
          (ssmDiagnostics.errorName === 'AccessDeniedException'
            ? ` → IAM 정책의 SSM/KMS Resource ARN 리전이 ${config.region}인지 확인하세요.`
            : ''),
      );
    } else if (!ssmDiagnostics.foundParameterNames.length) {
      problems.push(
        `SSM 경로 ${config.ssmPrefix} 에 파라미터가 0개입니다. ` +
          `리전 ${config.region}의 Parameter Store를 확인하세요 (다른 리전에 만들면 보이지 않습니다).`,
      );
    } else {
      const missing = [!hasGoogle && 'GOOGLE_BOOKS_API_KEY', !hasHardcover && 'HARDCOVER_TOKEN'].filter(Boolean);
      problems.push(
        `SSM에서 [${ssmDiagnostics.foundParameterNames.join(', ')}]는 찾았지만 ` +
          `[${missing.join(', ')}]가 없습니다. 파라미터 이름을 확인하세요.`,
      );
    }
  }

  const modelId = config.bedrock.modelId;
  const modelInfo = analyzeModelId(modelId, config.bedrock.region);
  problems.push(...modelInfo.problems);

  // 서비스는 동작하지만 품질이 떨어지는 상태 — ok 를 false 로 만들지는 않습니다
  const warnings = [];
  if (!hasAladin) {
    warnings.push(
      'ALADIN_TTB_KEY 가 없습니다 → 한국어 도서 결과가 빈약해집니다. ' +
        'docs/03-external-apis.md 8-A 참고.',
    );
  }
  if (!hasNlk) {
    warnings.push(
      'NLK_API_KEY 가 없습니다 → 국립중앙도서관 서지를 못 씁니다. '
        + '절판·구간·학술 국내서 검색이 약해집니다.',
    );
  }
  if (!hasHardcover) {
    warnings.push(
      'HARDCOVER_TOKEN 이 없습니다 → 무드 태그·커뮤니티 평점·내용 주의가 전부 없어 ' +
        '"위로되는 책" 같은 정서 기반 추천의 근거가 사라집니다.',
    );
  }

  return {
    ok: problems.length === 0,
    time: new Date().toISOString(),
    warnings,

    // 리전이 어디인지 명확히 — 리전 불일치가 대부분의 문제 원인입니다
    regions: {
      lambda: config.region,
      dynamodb: config.region, // Lambda와 동일 리전에 있어야 함
      ssm: config.region, // Lambda와 동일 리전에 있어야 함
      bedrock: config.bedrock.region, // 다른 리전이어도 됨
    },

    bedrock: {
      region: config.bedrock.region,
      modelId,
      inferenceScope: modelInfo.prefix,
      idFormat: modelInfo.generation,
      modelIdLooksValid: modelInfo.valid,
      note: modelInfo.note,
    },

    dynamodb: dynamo,

    // 값은 절대 노출하지 않고 "설정되었는지"만 알려줍니다
    // 함수 URL 직접 호출 차단이 활성화되었는지
    originGuard: secrets.ORIGIN_SECRET
      ? 'enabled (x-origin-secret 헤더 필요)'
      : 'disabled — 함수 URL을 아는 누구나 /api/chat 호출 가능. SSM에 ORIGIN_SECRET을 넣으세요',

    secrets: {
      GOOGLE_BOOKS_API_KEY: hasGoogle,
      HARDCOVER_TOKEN: hasHardcover,
      ALADIN_TTB_KEY: hasAladin,
      NLK_API_KEY: hasNlk,
      ORIGIN_SECRET: Boolean(secrets.ORIGIN_SECRET),
      ssmPrefix: config.ssmPrefix,
      ssmLookupOk: ssmDiagnostics.ok,
      ssmFoundNames: ssmDiagnostics.foundParameterNames,
      ssmError: ssmDiagnostics.errorName
        ? { name: ssmDiagnostics.errorName, message: ssmDiagnostics.errorMessage }
        : null,
    },

    // ★ 예산·반복 설정을 노출합니다.
    //
    //   왜: "새 코드가 배포됐는지" 를 확인할 방법이 없었습니다. 모델 ID 와 키 유무만
    //   보여서, 수정을 배포하고도 적용됐는지 알 수 없어 여러 번 헤맸습니다.
    //   handler 는 스트리밍/버퍼 중 무엇으로 도는지도 여기 있어야 합니다 —
    //   이 값 하나가 응답이 한꺼번에 오는지 흘러오는지를 결정합니다.
    runtime: {
      // requestBudgetMs 가 응답에 있으면 이 코드는 2026-09-01 이후 버전입니다
      requestBudgetMs: config.limits.requestBudgetMs,
      agentBudgetMs: config.limits.agentBudgetMs,
      maxToolIterations: config.limits.maxToolIterations,
      maxTokens: config.bedrock.maxTokens,
      historyTurns: config.limits.historyTurns,
      // 'stream' 이면 글이 흐르고, 'buffered' 면 다 만든 뒤 한꺼번에 옵니다
      responseMode: process.env.AWS_LAMBDA_FUNCTION_NAME && process.env._HANDLER
        ? (String(process.env._HANDLER).includes('bufferedHandler') ? 'buffered' : 'stream')
        : 'unknown',
      externalApiTimeoutMs: Number(process.env.EXTERNAL_API_TIMEOUT_MS || 5000),
      externalApiRetries: Number(process.env.EXTERNAL_API_RETRIES || 1),
    },

    limits: { perMinute: config.limits.perMinute, perDay: config.limits.perDay },

    // 이것만 읽으면 무엇을 고쳐야 하는지 알 수 있습니다
    problems,
  };
}

// ────────────────────────────────────────────────────────────────
// 채팅 실행 (스트리밍/버퍼 공용 코어)
// ────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.message
 * @param {string} params.sessionId
 * @param {string} params.ip
 * @param {(event:object)=>void} params.emit
 */
async function handleChat({ message, sessionId, ip, emit }) {
  const t0 = Date.now();

  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    emit({ type: 'error', code: 'rate_limited', message: rl.reason, retryAfterSeconds: rl.retryAfterSeconds });
    return;
  }

  emit({ type: 'session', sessionId });

  // ── 정책 검사 — /api/guard 와 동일한 모듈 ────────────────────
  //
  // 벤치마크(/api/guard)와 실서비스(/api/chat)가 같은 판정을 쓰도록
  // 여기서도 반드시 검사합니다. 분리하면 측정이 무의미해집니다.
  //
  // LLM 분류는 Bedrock 호출을 1회 추가하므로(약 300~600ms) 비용과 지연이
  // 늘어납니다. 캐시가 있어 반복 입력은 빠릅니다.
  const policy = await evaluatePolicy(message);

  // ★ 차단은 세 가지 경우뿐입니다.
  //     · 기술적 문제 (빈 입력·과길이·제어문자·인코딩 덩어리)
  //     · 미성년자 성적 대상화 (절대선)
  //     · 프롬프트 인젝션 (보안)
  //
  //   주제를 이유로 차단하지 않습니다. "한국전쟁", "제육볶음" 같은 입력은
  //   그 주제의 책을 찾는 요청으로 처리합니다.
  //   기능 요구("레시피 알려줘")도 차단하지 않습니다 — intent=SERVICE 로 통과시키고
  //   프롬프트가 "직접은 못 하지만 관련 책은 추천" 으로 전환합니다.
  if (policy.action === BLOCK) {
    log.info('정책 차단', { code: policy.code, layer: policy.layer, intent: policy.intent, ms: policy.ms, ip });
    const blockMessage = blockReason(policy.code);
    emit({ type: 'error', code: `policy_${policy.code}`, message: blockMessage });
    emit({ type: 'done', sessionId, blocked: true, usage: { inputTokens: 0, outputTokens: 0 } });

    // 차단된 요청도 기록합니다. 무엇이 왜 막혔는지 봐야 정책을 조정할 수 있습니다.
    await appendChatLog({
      sessionId,
      question: message,
      answer: blockMessage,
      blocked: true,
      policyCode: policy.code,
      ms: Date.now() - t0,
      ip,
    });
    return;
  }

  const [secrets, history] = await Promise.all([getSecrets(), loadHistory(sessionId)]);

  if (!secrets.GOOGLE_BOOKS_API_KEY && !secrets.HARDCOVER_TOKEN) {
    // 키가 하나도 없으면 Open Library + Gutendex만으로도 동작하지만 품질이 크게 떨어집니다.
    log.warn('외부 API 키가 하나도 설정되지 않았습니다', { hint: 'SSM /bookbot/prod/* 확인' });
  }

  // intent 를 넘겨 답변 첫 문장의 틀을 잡습니다.
  // SERVICE 면 "직접은 못 하지만 관련 책은 추천" 형식으로 시작해야 합니다.
  const result = await runAgent({
    userMessage: message,
    history,
    secrets,
    emit,
    intent: policy.intent,
  });

  // 히스토리 저장 (텍스트 턴만 — sessions.mjs 주석 참고)
  // 채팅 기록은 용도가 달라 따로 저장합니다 (24시간 뒤에도 남습니다).
  const [, logRef] = await Promise.all([
    saveHistory(sessionId, [
      ...history,
      { role: 'user', content: [{ text: message }] },
      { role: 'assistant', content: [{ text: result.answer || '(응답 없음)' }] },
    ]),
    appendChatLog({
      sessionId,
      question: message,
      answer: result.answer || '(응답 없음)',
      bookTitles: result.books.map((b) => b.title).filter(Boolean),
      toolCalls: result.toolCalls,
      usage: result.usage,
      ms: Date.now() - t0,
      ip,
    }),
  ]);

  emit({
    type: 'done',
    sessionId,
    usage: result.usage,
    toolCalls: result.toolCalls,
    bookCount: result.books.length,
    totalMs: Date.now() - t0,
    // 이 답변에 평가를 붙일 위치. 기록 저장이 실패했으면 null 이고,
    // 그 경우 프론트는 평가 버튼을 표시하지 않습니다.
    logRef,
  });

  log.info('chat 완료', {
    sessionId,
    ip,
    totalMs: Date.now() - t0,
    toolCalls: result.toolCalls,
    // 카드 선별 내역 — 검색으로 찾은 권수와 실제로 보여준 권수가 다릅니다.
    // 답변에서 언급된 책만 카드가 되므로 이 차이를 봐야 선별이 잘 되는지 압니다.
    booksFound: result.allBooks?.length ?? result.books.length,
    booksShown: result.books.length,
    selection: result.selection?.reason,
    ...result.usage,
    answerChars: result.answer.length,
  });
}

// ────────────────────────────────────────────────────────────────
// 1) 스트리밍 핸들러 (Function URL / RESPONSE_STREAM)
// ────────────────────────────────────────────────────────────────

const streamingImpl = async (event, responseStream) => {
  const { method, path, body, headers } = parseRequest(event);
  const cors = corsHeaders(headers.origin || headers.Origin);

  // 스트리밍 응답이 아닌 엔드포인트도 같은 스트림으로 처리합니다.
  const sendJson = (status, payload, extraHeaders) => {
    const s = globalThis.awslambda.HttpResponseStream.from(responseStream, {
      statusCode: status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...cors,
        ...(extraHeaders ?? {}),
      },
    });
    s.write(JSON.stringify(payload));
    s.end();
  };

  try {
    if (method === 'OPTIONS') return sendJson(204, {});
    if (method === 'GET' && (path === '/health' || path === '/')) return sendJson(200, await healthPayload());
    if (method === 'GET' && path === '/config') {
      return sendJson(200, configPayload(event));
    }

    if (method === 'POST' && path === '/guard') {
      const g = await handleGuard(body, clientIpFrom(event));
      const s = globalThis.awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...cors,
          ...g.headers,
        },
      });
      s.write(JSON.stringify(g.body));
      s.end();
      return undefined;
    }

    // ── 답변 평가 ───────────────────────────────────────────
    if (method === 'POST' && path === '/feedback') {
      const fb = await handleFeedbackRequest(body, headers, clientIpFrom(event));
      return sendJson(fb.status, fb.payload);
    }

    // ── OpenAI 호환 (GuardBench AI Application Target) ──────
    // 스트리밍하지 않습니다. 완성된 JSON 한 번으로 응답합니다 —
    // GuardBench 는 SSE 를 파싱하지 않고 본문 전체를 JSON 으로 읽습니다.
    //
    // ★ /api/chat 과 **같은** 오리진 비밀 검증을 겁니다.
    //   걸지 않으면 이 경로만 함수 URL 직접 호출이 가능해져 CloudFront 와
    //   WAF 를 통째로 우회하는 구멍이 됩니다(함수 URL 은 AuthType=NONE).
    //
    //   GuardBench 는 이 헤더를 보낼 수 없지만 문제가 되지 않습니다 —
    //   Target URL 을 **CloudFront 도메인**으로 등록하면 CloudFront 가
    //   오리진으로 보낼 때 주입합니다. 함수 URL 을 직접 등록하면 403 이 되고
    //   GuardBench 에는 TARGET_ACCESS_DENIED 로 기록됩니다.
    if (method === 'POST' && path === '/v1/chat/completions') {
      const gate = checkOriginSecret(headers, await getSecrets());
      if (!gate.ok) {
        log.warn('openai 엔드포인트 오리진 검증 실패 — 직접 호출로 추정', {
          reason: gate.reason, ip: clientIpFrom(event),
        });
        return sendJson(403, { error: { message: 'Forbidden', type: 'invalid_request_error', code: 'forbidden' } });
      }
      const oa = await handleChatCompletions({ body, ip: clientIpFrom(event) });
      return sendJson(oa.status, oa.payload, oa.headers);
    }

    if (method !== 'POST' || path !== '/chat') {
      return sendJson(404, { error: 'Not Found', path });
    }

    // CloudFront를 거치지 않은 직접 호출 차단
    const gate = checkOriginSecret(headers, await getSecrets());
    if (!gate.ok) {
      log.warn('오리진 비밀 헤더 검증 실패 — 직접 호출로 추정', {
        reason: gate.reason,
        ip: clientIpFrom(event),
      });
      return sendJson(403, { error: 'Forbidden' });
    }

    const v = validateChat(body);
    if (v.error) return sendJson(v.status, { error: v.error });

    // ── SSE 시작 ──
    const stream = globalThis.awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { ...SSE_HEADERS, ...cors },
    });

    let closed = false;
    const emit = (payload) => {
      if (closed) return;
      try {
        stream.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        closed = true;
        log.warn('SSE write 실패 (클라이언트 연결 종료 추정)', { err: err.message });
      }
    };

    // 즉시 한 바이트 보내서 TTFB를 낮추고 프록시 버퍼링을 깨운다
    stream.write(': open\n\n');

    try {
      await handleChat({
        message: v.message,
        sessionId: v.sessionId,
        ip: clientIpFrom(event),
        emit,
      });
    } catch (err) {
      log.error('chat 처리 중 오류', { err });
      emit({
        type: 'error',
        code: err.name || 'internal_error',
        // userSafe 플래그가 붙은 에러(agent.mjs의 Bedrock 진단 메시지)만 그대로 노출
        message: err.userSafe ? err.message : '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      });
    } finally {
      closed = true;
      stream.end();
    }
  } catch (err) {
    log.error('핸들러 최상위 오류', { err });
    try {
      responseStream.write(`data: ${JSON.stringify({ type: 'error', message: '서버 오류' })}\n\n`);
      responseStream.end();
    } catch {
      /* 이미 닫힘 */
    }
  }
};

/**
 * streamifyResponse는 Lambda 런타임에서만 존재하는 전역(awslambda)에 의존합니다.
 * 로컬에서 import만 해도 터지지 않게 가드를 둡니다.
 */
export const handler = globalThis.awslambda?.streamifyResponse
  ? globalThis.awslambda.streamifyResponse(streamingImpl)
  : streamingImpl;

// ────────────────────────────────────────────────────────────────
// 2) 버퍼 핸들러 (API Gateway HTTP API 또는 BUFFERED 모드)
//    스트리밍이 안 되는 환경에서의 폴백. 응답을 한 번에 반환합니다.
// ────────────────────────────────────────────────────────────────

export const bufferedHandler = async (event) => {
  const { method, path, body, headers } = parseRequest(event);
  const cors = corsHeaders(headers.origin || headers.Origin);
  const json = (statusCode, payload) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
    body: JSON.stringify(payload),
  });

  try {
    if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
    if (method === 'GET' && (path === '/health' || path === '/')) return json(200, await healthPayload());
    if (method === 'GET' && path === '/config') {
      return json(200, configPayload(event));
    }

    // ── GuardBench 계약 엔드포인트 ──────────────────────────
    if (method === 'POST' && path === '/guard') {
      const g = await handleGuard(body, clientIpFrom(event));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors, ...g.headers },
        body: JSON.stringify(g.body),
      };
    }

    // ── 답변 평가 ───────────────────────────────────────────
    if (method === 'POST' && path === '/feedback') {
      const fb = await handleFeedbackRequest(body, headers, clientIpFrom(event));
      return json(fb.status, fb.payload);
    }

    // ── OpenAI 호환 (GuardBench AI Application Target) ──────
    // 스트리밍 핸들러와 같은 이유로 오리진 비밀을 검증합니다(위 주석 참고).
    if (method === 'POST' && path === '/v1/chat/completions') {
      const gate = checkOriginSecret(headers, await getSecrets());
      if (!gate.ok) {
        log.warn('openai 엔드포인트 오리진 검증 실패', {
          reason: gate.reason, ip: clientIpFrom(event),
        });
        return json(403, { error: { message: 'Forbidden', type: 'invalid_request_error', code: 'forbidden' } });
      }
      const oa = await handleChatCompletions({ body, ip: clientIpFrom(event) });
      return {
        statusCode: oa.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...cors,
          ...(oa.headers ?? {}),
        },
        body: JSON.stringify(oa.payload),
      };
    }

    if (method !== 'POST' || path !== '/chat') return json(404, { error: 'Not Found', path });

    const gate = checkOriginSecret(headers, await getSecrets());
    if (!gate.ok) {
      log.warn('오리진 비밀 헤더 검증 실패', { reason: gate.reason, ip: clientIpFrom(event) });
      return json(403, { error: 'Forbidden' });
    }

    const v = validateChat(body);
    if (v.error) return json(v.status, { error: v.error });

    // 스트리밍 이벤트를 배열로 모아서 한 번에 반환 (프론트가 동일 로직으로 처리 가능)
    const events = [];
    await handleChat({
      message: v.message,
      sessionId: v.sessionId,
      ip: clientIpFrom(event),
      emit: (e) => events.push(e),
    });

    const rateLimited = events.find((e) => e.type === 'error' && e.code === 'rate_limited');
    if (rateLimited) return json(429, rateLimited);

    return json(200, {
      sessionId: v.sessionId,
      answer: events.filter((e) => e.type === 'delta').map((e) => e.text).join(''),
      books: events.filter((e) => e.type === 'books').flatMap((e) => e.items),
      events,
    });
  } catch (err) {
    log.error('bufferedHandler 오류', { err });
    return json(500, {
      type: 'error',
      message: err.userSafe ? err.message : '처리 중 오류가 발생했습니다.',
    });
  }
};
