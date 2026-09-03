/**
 * 로컬 HTTP 서버 — 배포하지 않고 curl 로 계약을 확인하는 도구입니다.
 *
 * Lambda 이벤트(payload 2.0)를 흉내내서 `bufferedHandler` 에 넘깁니다.
 * 실제 게이트웨이가 하는 일(경로·메서드·본문 전달)만 재현합니다.
 *
 *   실행:
 *     LOCAL_FAKE_BEDROCK=1 node scripts/local-server.mjs
 *     curl -X POST http://127.0.0.1:8787/api/v1/chat/completions \
 *       -H 'Content-Type: application/json' -H 'Accept: application/json' \
 *       -d '{"model":"bookbot","messages":[{"role":"user","content":"hi"}]}'
 *
 * 환경 변수
 *   PORT=8787                로컬 포트
 *   LOCAL_FAKE_BEDROCK=1     Bedrock 을 가짜로 대체합니다. AWS 자격증명이
 *                            없거나 권한이 막힌 환경에서 HTTP 계약만 볼 때 씁니다.
 *   LOCAL_FAKE_ANSWER=...    가짜 답변 문구
 *
 * ⚠️ Lambda 배포 zip 에는 들어가지 않습니다 — `scripts/build.sh` 가 `src/` 만
 *    복사합니다. (CloudShell 소스 번들에는 다른 스크립트와 함께 포함됩니다)
 *    인증도 레이트리밋 DDB 도 없이 도는 개발 도구입니다. 공개 호스트에서 띄우지 마세요.
 */
process.env.TABLE_NAME = process.env.TABLE_NAME || 'bookbot';
process.env.BOOKBOT_LOCAL = process.env.BOOKBOT_LOCAL || '1';
process.env.BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'fake.model';

const FAKE = process.env.LOCAL_FAKE_BEDROCK === '1';
const FAKE_ANSWER = process.env.LOCAL_FAKE_ANSWER
  || '요청하신 주제로 책을 정리했습니다. 《토지》 — 박경리 (1969) 한국 근현대사를 담은 대하소설입니다.';

if (FAKE) {
  // 정책 LLM 분류까지 가짜 Bedrock 을 타면 호출 순서가 얽힙니다.
  // 규칙 레이어만 쓰도록 끕니다 (미성년 보호·인젝션·PII 는 그대로 동작).
  process.env.POLICY_LLM_CHECK = process.env.POLICY_LLM_CHECK || '0';

  const sdk = await import('@aws-sdk/client-bedrock-runtime');
  sdk.BedrockRuntimeClient.prototype.send = async function fakeSend() {
    return {
      stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: FAKE_ANSWER } } };
        yield { messageStop: { stopReason: 'end_turn' } };
        yield { metadata: { usage: { inputTokens: 42, outputTokens: 30, totalTokens: 72 } } };
      })(),
    };
  };
  console.log('※ Bedrock 을 가짜로 대체했습니다 (LOCAL_FAKE_BEDROCK=1)');
}

const http = await import('node:http');
const { bufferedHandler } = await import('../src/index.mjs');

const PORT = Number(process.env.PORT || 8787);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const [pathOnly, query = ''] = req.url.split('?');

    // API Gateway HTTP API payload 2.0 과 같은 모양
    const event = {
      version: '2.0',
      rawPath: pathOnly,
      rawQueryString: query,
      headers: req.headers,
      body: raw || undefined,
      isBase64Encoded: false,
      requestContext: {
        http: { method: req.method, path: pathOnly, sourceIp: '127.0.0.1' },
      },
    };

    try {
      const out = await bufferedHandler(event);
      const headers = out.headers ?? {};
      res.writeHead(out.statusCode ?? 200, headers);
      res.end(out.body ?? '');
      console.log(`${req.method} ${req.url} → ${out.statusCode} (${(out.body ?? '').length}B)`);
    } catch (err) {
      console.error('핸들러 예외', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`로컬 서버 http://127.0.0.1:${PORT}`);
  console.log(`  POST /api/v1/chat/completions   OpenAI 호환 (GuardBench Target)`);
  console.log(`  POST /api/chat                  기존 채팅 (버퍼 모드)`);
  console.log(`  POST /api/guard                 정책 판정`);
  console.log(`  GET  /api/config                예시 질문`);
});
