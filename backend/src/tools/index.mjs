/**
 * 도구(tool) 스펙 정의 + 디스패처
 *
 * Bedrock Converse API의 `toolConfig`에 이 스펙을 넘기면, LLM이 사용자 발화를 보고
 * "어떤 도구를 어떤 인자로 부를지" 스스로 결정합니다. (function calling / tool use)
 *
 * ★ 도구 설명(description)을 잘 쓰는 것이 이 프로젝트 품질의 80%입니다. ★
 *   LLM은 이 설명만 보고 도구를 고릅니다. "언제 쓰는지"와 "언제 쓰지 말아야 하는지"를
 *   구체적으로 적어야 엉뚱한 도구를 부르지 않습니다.
 *
 * 각 도구는 { llmText, books } 를 반환합니다:
 *   llmText — LLM에게 줄 압축 텍스트 (토큰 절약)
 *   books   — 프론트엔드로 SSE 사이드 채널로 보낼 전체 레코드 (카드 렌더용)
 */

import { searchGoogleBooks, buildQuery } from './googleBooks.mjs';
import { searchOpenLibrary, browseSubject, searchFreeFullText } from './openLibrary.mjs';
import { searchGutendex } from './gutendex.mjs';
import { searchHardcover } from './hardcover.mjs';
import { searchAladin, hasHangul } from './aladin.mjs';
import { searchNlk, lookupNlk } from './nlk.mjs';
import { interpret } from './genre.mjs';
import { parseItems, pickBest, looksKorean } from './lookup.mjs';
import { mergeBooks, compactForLlm } from './merge.mjs';
import { withCache } from '../lib/cache.mjs';
import { toIsbn13 } from '../lib/isbn.mjs';
import { log } from '../lib/log.mjs';

// ────────────────────────────────────────────────────────────────
// 1. Bedrock에 넘길 도구 스펙
// ────────────────────────────────────────────────────────────────

export const toolConfig = {
  tools: [
    {
      toolSpec: {
        name: 'search_books',
        description: [
          '실제로 존재하는 책을 도서 데이터베이스 5곳(Google Books, Open Library, Hardcover,',
          'Project Gutenberg, 알라딘)에서 동시에 검색하고 결과를 병합해서 돌려준다.',
          '',
          '★ 한국 도서 ★',
          '한국어 검색어를 넣으면 알라딘(국내 도서 DB)이 자동으로 함께 검색된다.',
          '따라서 한국 책을 찾을 때는 억지로 영어로 바꾸지 말고 **한국어 그대로** 넣어라.',
          '  좋음: query: "한강 소년이 온다"  /  query: "한국 근대 성매매 소설"',
          '  나쁨: query: "kisaeng"  (로마자 음역은 어느 DB에도 없다)',
          'language: "ko" 를 함께 넣으면 더 확실하다.',
          '',
          '★ 지역과 장르를 섞지 마라 (중요) ★',
          '"한국"을 검색 키워드로 넣으면 요청한 장르가 아니라 **한국을 다룬 책**',
          '(한국사·정치·여행서)이 나온다. 실제로 그런 사고가 있었다.',
          '  나쁨: query: "한국 스릴러"',
          '  좋음: query: "스릴러", subject: "thriller", language: "ko"',
          '지역·언어는 language 에, 장르는 subject 에 넣어라. query 에는 고유명사와',
          '실제 키워드만 남긴다. (코드가 보정하지만, 처음부터 나눠 넣으면 결과가 더 좋다)',
          '',
          '★ 0권이 나왔을 때 ★',
          '검색어를 지역명(한국/Korea/Korean)으로 바꿔 재검색하지 마라. 주제를 벗어난다.',
          '같은 뜻의 다른 말로 두 번 이상 재검색하지 마라. 결과가 좋아지지 않는다.',
          '결과가 없으면 없다고 사용자에게 알려라. 책 제목을 지어내지 마라.',
          '',
          '언제 쓰는가:',
          '- 사용자가 특정 책/저자/키워드를 언급했을 때',
          '- 책을 추천하기 전 후보를 확보할 때 (추천 전에는 반드시 이 도구를 먼저 호출)',
          '',
          '언제 쓰지 않는가:',
          '- 정서적 무드나 넓은 주제로 탐색할 때는 browse_by_subject 가 결과가 더 좋다',
          '- 무료로 읽을 수 있는 고전만 찾을 때는 find_free_ebooks 를 쓴다',
          '',
          '★ 신간 요청 처리 ★',
          '사용자가 "최신", "신간", "요즘 나온", "올해 나온", "새로 나온", "2026년" 등을 언급하면',
          'recent=true 를 반드시 함께 넣어라. 그러면 검색·정렬 전체가 출간일 기준으로 바뀐다.',
          'recent 없이 검색하면 유명한 구간(舊刊)만 돌아온다.',
          '특정 연도 이후만 원하면 yearFrom 에 그 연도를 넣어라.',
          '',
          '반환: 제목, 저자, 출판연도, 평점, 장르, 무드, 콘텐츠 경고, ISBN, 무료 전문 여부.',
        ].join('\n'),
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: '핵심 검색어. 사용자 발화 전체가 아니라 검색에 쓸 명사구로 다듬어서 넣는다. 예: "시간 여행 SF"',
              },
              author: { type: 'string', description: '저자명으로 좁힐 때만' },
              title: { type: 'string', description: '정확한 제목을 알 때만' },
              subject: {
                type: 'string',
                description:
                  '장르. 여기에 넣으면 소스별 정식 분류로 번역되고, 주제가 어긋난 결과가 걸러진다. '
                  + '한국어·영어 모두 인식한다. 예: "thriller", "스릴러", "mystery", "science fiction", '
                  + '"romance", "fantasy", "horror", "essay", "self-help", "history"',
              },
              language: {
                type: 'string',
                description:
                  'ISO 639-1 코드. 한국어 도서를 원하면 "ko" — 이 값을 넣으면 알라딘 국내 도서 DB가 '
                  + '함께 검색된다. 영어권이면 "en". 불확실하면 생략.',
              },
              recent: {
                type: 'boolean',
                description:
                  '신간 우선 모드. "최신/신간/요즘 나온/올해 나온/새로 나온" 요청이면 true. '
                  + 'Google Books는 출간일 역순, Open Library는 최근 2년 필터, Hardcover는 발매일순으로 바뀐다.',
              },
              yearFrom: {
                type: 'integer',
                description: '이 연도 이후 출간된 책만. 예: 2024. recent=true 를 쓰면 자동 설정되므로 보통 생략한다.',
              },
              limit: { type: 'integer', description: '1~20, 기본 14. 10권 이상 추천하려면 넉넉히 받아야 합니다' },
            },
            required: ['query'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'browse_by_subject',
        description: [
          '주제/정서 태그로 책을 탐색한다. Open Library의 subject 분류와 Hardcover의 mood/genre 태그를 함께 사용한다.',
          '',
          '언제 쓰는가:',
          '- "요즘 좀 지쳤는데 위로되는 책", "긴장감 있는 스릴러", "잠들기 전에 읽을 편안한 책" 처럼',
          '  구체적 제목 없이 분위기·주제로 요청할 때 (이 도구가 search_books 보다 훨씬 낫다)',
          '- 특정 장르를 폭넓게 둘러볼 때',
          '',
          'subject 값은 영어로 넣어야 결과가 잘 나온다. 예:',
          '  science_fiction, fantasy, detective_and_mystery_stories, love, self-help,',
          '  historical_fiction, philosophy, biography, psychology, poetry, humor, horror',
          '',
          '성인·무거운 주제도 정식 subject 가 있다. 검열하지 말고 아래 슬러그를 쓴다:',
          '  erotic_fiction (에로티카 — Anaïs Nin, Fanny Hill 등 321권)',
          '  prostitution (성매매를 다룬 문학 — Moll Flanders, Memoirs of a Geisha 등 6,589권)',
          '  erotic_stories, love_stories, sex, sexuality,',
          '  crime, murder, serial_murderers, violence, war, drug_abuse, addiction,',
          '  suicide, incest, slavery, rape, abuse',
          '',
          '★ 한국 도서를 원하면 language: "ko" 를 넣어라.',
          '  그러면 알라딘(국내 도서 DB)이 함께 검색된다.',
          '  이때 moodQuery 에는 **한국어** 검색어를 넣는 것이 좋다.',
          '    예: subject: "prostitution", moodQuery: "한국 근대 성매매 소설", language: "ko"',
          '  subject 슬러그 자체는 영어여야 한다(Open Library 규칙).',
          '',
          '  특정 한국 주제는 search_books 쪽이 더 정확하다:',
          '    위안부 → search_books(query: "위안부 소설", language: "ko")',
        ].join('\n'),
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              subject: {
                type: 'string',
                description: 'Open Library subject 슬러그(영어, 공백은 언더스코어). 예: "detective_and_mystery_stories"',
              },
              moodQuery: {
                type: 'string',
                description:
                  '무드/느낌으로 검색할 자연어 구문. Hardcover 용이라 영어 권장. 예: "cozy comforting slice of life". '
                  + '단 language: "ko" 를 함께 쓰면 이 값이 알라딘 검색어로도 쓰이므로 한국어가 낫다.',
              },
              language: {
                type: 'string',
                description: 'ISO 639-1 코드. "ko" 를 넣으면 알라딘 국내 도서 DB가 함께 검색된다.',
              },
              recent: {
                type: 'boolean',
                description: '신간 우선 모드. "요즘 나온 힐링 소설"처럼 무드 + 최신을 함께 요청할 때 true.',
              },
              yearFrom: { type: 'integer', description: '이 연도 이후 출간된 책만. 예: 2024' },
              limit: { type: 'integer', description: '1~20, 기본 14. 10권 이상 추천하려면 넉넉히 받아야 합니다' },
            },
            required: ['subject'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'lookup_books',
        description: [
          '★ 추천할 책을 이미 알고 있을 때 쓰는 도구다. 이 서비스에서 가장 정확하다. ★',
          '',
          '네가 아는 책의 **제목과 저자를 직접 지목**하면, 각 책을 도서 DB에서',
          '제목·저자 정확 조회로 확인하고 표지·평점·ISBN·구매 링크를 붙여 돌려준다.',
          '확인되지 않은 책은 버리고 어느 것이 실패했는지 알려준다.',
          '',
          '언제 쓰는가 (중요):',
          '- "한국 스릴러", "일본 미스터리", "위로되는 소설" 처럼 **장르·분위기 요청**일 때',
          '  키워드 검색(search_books)은 이런 요청에서 엉뚱한 책을 준다. 검색 엔진이',
          '  "한국" 을 주제어로 읽어 한국사·여행서를 돌려주기 때문이다. 실제로 그런 사고가 있었다.',
          '  대신 네가 아는 그 장르의 대표작을 3~6권 지목해서 이 도구로 확인해라.',
          '    예: items: [{title:"종의 기원", author:"정유정"}, {title:"7년의 밤", author:"정유정"},',
          '                {title:"설계자", author:"김언수"}]',
          '- 사용자가 특정 작가의 작품들을 물을 때',
          '- 이미 대화에서 언급된 책들의 카드를 만들 때',
          '',
          '언제 쓰지 않는가:',
          '- "요즘 나온", "신간", "올해 나온" 요청 — 네 지식은 최신 출간을 모른다.',
          '  이때는 search_books(recent: true) 를 써라.',
          '- 네가 그 분야를 잘 모를 때 — 없는 책을 만들어내면 확인에 실패하고 결과가 줄어든다.',
          '  모르면 search_books 로 탐색해라.',
          '',
          '규칙:',
          '- 저자를 반드시 함께 넣어라. 저자가 없으면 같은 제목의 다른 책이 잡힌다.',
          '- 제목은 **원제 그대로**. 번역하거나 로마자로 바꾸지 마라.',
          '  한국 책은 한국어 제목("종의 기원"), 영미 책은 영어 제목("Gone Girl").',
          '- 한 번에 3~10권. 많을수록 느려진다.',
          '- 확인 실패한 책은 **답변에서 언급하지 마라.** 그 책은 존재가 검증되지 않았다.',
        ].join('\n'),
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                description: '확인할 책 목록. 각 항목에 title 과 author 를 넣는다.',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: '책의 원제. 번역하지 않는다.' },
                    author: { type: 'string', description: '지은이. 반드시 넣는다.' },
                  },
                  required: ['title'],
                },
              },
              language: {
                type: 'string',
                description:
                  'ISO 639-1. "ko" 면 국내 도서 DB(알라딘)를 우선 조회한다. '
                  + '제목에 한글이 있으면 자동 판단하므로 보통 생략해도 된다.',
              },
            },
            required: ['items'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'find_free_ebooks',
        description: [
          'Project Gutenberg(Gutendex)에서 저작권이 만료되어 지금 바로 무료로 읽을 수 있는 책을 찾는다.',
          '실제 다운로드 링크(EPUB / TXT / HTML)를 함께 반환한다.',
          '',
          '언제 쓰는가:',
          '- 사용자가 "무료", "공짜", "돈 안 들이고", "지금 바로 읽을 수 있는" 등을 언급했을 때',
          '- 고전문학을 추천할 때 (거의 항상 무료 전문이 있으므로 함께 제시하면 만족도가 높다)',
          '',
          '한계: 대부분 1929년 이전 영미권 도서다. 최신 도서나 한국어 도서는 거의 없다.',
          '따라서 최신 책을 원하는 요청에는 쓰지 않는다.',
        ].join('\n'),
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '제목 또는 저자 검색어 (영어 권장)' },
              topic: { type: 'string', description: 'Gutenberg 서가/주제 키프레이즈. 예: "detective", "philosophy", "adventure"' },
              language: { type: 'string', description: '2자 코드. 기본 "en". 여러 개는 쉼표. 예: "en,fr"' },
              limit: { type: 'integer', description: '1~10, 기본 6' },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'get_book_detail',
        description: [
          '책 한 권의 상세 정보를 4개 소스에서 모두 조회해 병합한다.',
          'ISBN을 알면 ISBN으로, 모르면 제목+저자로 조회한다.',
          '',
          '언제 쓰는가:',
          '- 사용자가 특정 책 하나에 대해 더 깊이 물을 때 ("그 책 몇 페이지야?", "무슨 내용이야?")',
          '- 추천한 책에 콘텐츠 경고나 시리즈 정보가 필요할 때',
          '',
          '주의: 여러 권을 한꺼번에 조회하려면 이 도구를 반복 호출하지 말고 search_books를 쓴다.',
        ].join('\n'),
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              isbn: { type: 'string', description: 'ISBN-10 또는 ISBN-13 (하이픈 있어도 됨)' },
              title: { type: 'string', description: 'ISBN이 없을 때 사용할 정확한 제목' },
              author: { type: 'string', description: '제목으로 조회할 때 함께 넣으면 정확도가 올라간다' },
            },
          },
        },
      },
    },
  ],
};

/** 프론트엔드 진행 표시용 라벨 */
export const TOOL_LABELS = {
  search_books: '4개 도서 DB 통합 검색',
  browse_by_subject: '주제·분위기 기반 탐색',
  find_free_ebooks: '무료 전자책(구텐베르크) 검색',
  get_book_detail: '책 상세 정보 조회',
};

// ────────────────────────────────────────────────────────────────
// 2. 디스패처
// ────────────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @param {object} input   LLM이 만든 인자
 * @param {{ GOOGLE_BOOKS_API_KEY?:string, HARDCOVER_TOKEN?:string }} secrets
 * @returns {Promise<{ llmText: string, books: import('./merge.mjs').NormalizedBook[], meta: object }>}
 */
export async function runTool(name, input, secrets) {
  const t0 = Date.now();
  const gbKey = secrets?.GOOGLE_BOOKS_API_KEY || '';
  const hcToken = secrets?.HARDCOVER_TOKEN || '';
  const alKey = secrets?.ALADIN_TTB_KEY || '';
  const nlKey = secrets?.NLK_API_KEY || '';

  // ★ 상한을 20 으로 올렸습니다.
  //
  //   답변에서 10권 이상 추천하게 바꿨는데, 도구가 8권만 돌려주면
  //   시리즈 접기까지 거치면 5~6권밖에 남지 않습니다.
  //   권당 압축 텍스트가 약 110 토큰이라 20권이어도 2,200 토큰 수준입니다.
  const clampLimit = (n, def, max = 20) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), 1), max) : def;
  };

  try {
    switch (name) {
      // ── 통합 검색: 3개 소스 병렬 fan-out ─────────────────────
      case 'search_books': {
        const limit = clampLimit(input.limit, 14);
        const { recent, yearFrom, yearTo } = recencyOptions(input);

        // ★ 질의를 장르·언어·키워드로 분해합니다.
        //
        //   "한국 스릴러" 를 그대로 검색하면 "한국" 이 키워드로 나가서
        //   제목·주제에 한국이 든 책, 즉 한국사·한국학 서적이 매칭됩니다.
        //   실측: Open Library "Korea" → Pyongyang / Korea's Place in the Sun / 여행서.
        //   그래서 지역어는 language 로 옮기고 키워드에서 뺍니다.
        const hint = interpret(input);
        const language = hint.language || normalizeLang(input.language);

        // Google Books 는 subject: 연산자가 있습니다. 장르를 자유어로 던지는 것보다
        // 훨씬 정확합니다. 남은 키워드는 그대로 자유어로 붙입니다.
        const gbQuery = buildQuery({
          text: hint.keywords || (hint.genre ? '' : input.query),
          title: input.title,
          author: input.author,
          subject: hint.genre ? hint.genre.gbSubject : input.subject,
        });

        // Open Library·Hardcover 용 평문 질의. 지역어를 뺀 키워드를 씁니다.
        const plainQuery = [hint.keywords || (hint.genre ? hint.genre.hcQuery : input.query), input.title, input.author]
          .filter(Boolean)
          .join(' ')
          .trim();

        // 알라딘(국내 도서)은 한국어 맥락일 때만 부릅니다.
        // 영어권 검색에 매번 호출하면 지연만 늘고 결과는 안 나옵니다.
        const wantKorean = language === 'ko' || hasHangul(hint.rawQuery);

        // ★ 알라딘·국중에는 **한국어 조각만** 보냅니다.
        //
        //   실제 사고: 영어권 사용자가 "an old korean book" 이라고 물었습니다.
        //   interpret() 이 'korean' 이라는 낱말을 보고 language='ko' 로 잡고,
        //   남은 키워드 "an old book" 을 그대로 알라딘에 보냈습니다.
        //   알라딘은 한국 서점입니다. 영어 문장으로는 0권이 나옵니다.
        //   국중도 0권 → "국내 도서 검색이 원활하지 않다" 는 안내가 사용자에게 갔고,
        //   모델은 자기 지식의 한국 책을 한국어로 나열했습니다.
        //
        //   → 영어 키워드는 국내 소스에 보내지 않습니다. 장르는 사전에서 한국어로
        //     번역되므로("thriller" → "스릴러") 그건 쓸 수 있습니다.
        //     보낼 한국어가 하나도 없으면 아래에서 국내 소스를 아예 건너뜁니다.
        const alQuery = [
          hasHangul(hint.keywords) ? hint.keywords : '',
          wantKorean && hint.genre ? hint.genre.aladin : '',
        ]
          .filter(Boolean)
          .join(' ')
          .trim()
          || (hasHangul(hint.rawQuery) ? hint.rawQuery : '');

        // 국내 소스를 부를 의미가 있는가. 보낼 한국어가 없으면 부르지 않습니다 —
        // 두 번의 왕복을 낭비하고 사용자에게 잘못된 안내까지 가게 됩니다.
        const koQueryUsable = wantKorean && alQuery.length > 0;

        const relevance = { genre: hint.genre, keywords: hint.keywords, language };

        const { value: found } = await withCache(
          // ⚠️ 캐시 키에 recent/yearFrom 을 반드시 포함. 빠뜨리면 일반 검색 결과가
          //    신간 요청에 재사용되어 수정이 무효화됩니다.
          //    wantKorean 도 같은 이유로 포함합니다 — 소스 구성이 달라지므로
          //    같은 검색어라도 결과가 다릅니다.
          //    genre 도 포함합니다 — 같은 원문이라도 해석된 장르가 다르면
          //    소스별 질의와 필터가 달라집니다.
          'search_books',
          { gbQuery, plainQuery, alQuery, language, limit, recent, yearFrom, koQueryUsable, genre: hint.genre?.key ?? '' },
          async () => {
            // ★ 언어별로 소스를 갈라 부릅니다.
            //
            //   국내서에 Open Library 를 부르면 품질이 오히려 떨어집니다.
            //   실측: "한국 소설" → 「한국 현대 소설 연구」, 「1960년대 한국 소설 연구」
            //         (소설이 아니라 소설 **연구서** 입니다)
            //         "Korea" → Pyongyang / Korea's Place in the Sun / 여행서
            //   Hardcover 도 국내서 커버리지가 ★☆☆☆☆ 라 지연만 늘립니다.
            //
            //   그래서 한국어 맥락에서는 국내 소스만 먼저 씁니다.
            //   그게 0권이면 그때만 영어권 소스로 물러납니다(아무것도 없는 것보다는 낫습니다).
            // 한국 책을 원하지만 보낼 한국어 검색어가 없는 경우
            // (예: 영어로 "an old korean book"). 국내 소스는 0권이 확정이므로
            // 건너뛰고 Google Books 로 갑니다. langRestrict=ko 라 한국어 책은 나옵니다.
            if (wantKorean && !koQueryUsable) {
              log.info('한국 책 요청이지만 한국어 검색어가 없음 — 국내 소스 건너뜀', {
                rawQuery: hint.rawQuery, keywords: hint.keywords,
              });
              const gb = await Promise.allSettled([
                searchGoogleBooks({
                  query: gbQuery, apiKey: gbKey, limit, language,
                  orderBy: recent ? 'newest' : 'relevance',
                }),
              ]);
              const gbFailures = logSettled('search_books.ko-via-gb', gb, ['googleBooks']);
              const merged = mergeBooks(gb.map(unwrap), limit, { preferRecent: recent, relevance });
              return { merged, failures: gbFailures, sources: 'ko-via-gb' };
            }

            if (koQueryUsable) {
              const ko = await Promise.allSettled([
                searchAladin({ query: alQuery, key: alKey, limit, recent }),
                // 국립중앙도서관 — 납본 기관이라 국내 출간서가 사실상 전부 있습니다.
                // 알라딘이 모르는 절판·구간·학술서를 여기서 채웁니다.
                searchNlk({ query: alQuery, key: nlKey, limit, recent }),
              ]);
              const koFailures = logSettled('search_books.ko', ko, ['aladin', 'nlk']);
              const koGroups = ko.map(unwrap);
              const koBooks = koGroups.flat();

              if (koBooks.length) {
                // 소스별 배열을 따로 넘겨야 ISBN 기준으로 병합됩니다.
                // flat 해서 한 배열로 주면 같은 책이 두 번 들어갑니다.
                const merged = mergeBooks(koGroups, limit, { preferRecent: recent, relevance });
                return { merged, failures: koFailures, sources: 'ko' };
              }

              // 국내 소스가 비었습니다 — 알라딘 키가 없거나 검색어가 안 맞은 경우입니다.
              log.info('국내 소스 0권 — 영어권 소스로 폴백', { alQuery, hasAladinKey: Boolean(alKey) });
              const fb = await Promise.allSettled([
                searchGoogleBooks({
                  query: gbQuery, apiKey: gbKey, limit, language,
                  orderBy: recent ? 'newest' : 'relevance',
                }),
              ]);
              const fbFailures = logSettled('search_books.fallback', fb, ['googleBooks']);
              const merged = mergeBooks(fb.map(unwrap), limit, { preferRecent: recent, relevance });
              return { merged, failures: [...koFailures, ...fbFailures], sources: 'fallback' };
            }

            // 영어권 경로 — 여기서는 Google Books·Open Library 가 유일한 현대 도서 소스입니다.
            // Promise.allSettled: 한 소스가 죽어도 나머지로 답한다 (부분 실패 허용)
            const results = await Promise.allSettled([
              searchGoogleBooks({
                query: gbQuery, apiKey: gbKey, limit, language,
                orderBy: recent ? 'newest' : 'relevance',
              }),
              searchOpenLibrary({ query: plainQuery, limit, language, yearFrom, yearTo }),
              searchHardcover({
                query: plainQuery, token: hcToken, limit,
                // Typesense 정렬 필드. 실패하면 allSettled 가 흡수하고 나머지 소스로 답합니다.
                sort: recent ? 'release_date_i:desc' : undefined,
              }),
            ]);
            const failures = logSettled('search_books', results, ['googleBooks', 'openLibrary', 'hardcover']);
            const merged = mergeBooks(results.map(unwrap), limit, { preferRecent: recent, relevance });
            return { merged, failures, sources: 'en' };
          },
        );

        const books = found.merged ?? [];
        const label = describeSearch({ hint, language, recent, yearFrom });
        return {
          llmText: books.length
            ? header(books, label) + compactForLlm(books) + (recent ? recentCaveat(books) : '')
            : emptyGuidance({ label, failures: found.failures, wantKorean, secrets }),
          books,
          meta: { count: books.length, recent, genre: hint.genre?.key, durationMs: Date.now() - t0 },
        };
      }

      // ── 주제/무드 탐색: Open Library subject + Hardcover mood ──
      case 'browse_by_subject': {
        const limit = clampLimit(input.limit, 14);
        const rawSubject = String(input.subject || '').trim();
        const moodQuery = String(input.moodQuery || '').trim();
        const { recent, yearFrom, yearTo } = recencyOptions(input);

        // subject 가 사전에 있는 장르면 소스별 정식 값으로 바꿔 씁니다.
        // LLM 이 "한국 스릴러" 처럼 지역어를 섞어 넣어도 여기서 분리됩니다.
        const hint = interpret({ subject: rawSubject, query: moodQuery, language: input.language });
        const subject = hint.genre?.olSubjects?.[0] || rawSubject;

        // 주제 탐색에서는 subject 가 영어 슬러그라 한글이 없습니다.
        // 그래서 명시적으로 language: "ko" 를 받았거나 무드 질의가 한국어일 때 부릅니다.
        const wantKorean = (hint.language || normalizeLang(input.language)) === 'ko' || hasHangul(moodQuery);

        // 알라딘에는 한국어 장르어를 보냅니다. 영어 슬러그는 안 통합니다.
        const alQuery = [hint.keywords, hint.genre?.aladin].filter(Boolean).join(' ').trim()
          || moodQuery
          || subject.replace(/_/g, ' ');

        const relevance = {
          genre: hint.genre,
          keywords: hint.keywords,
          language: hint.language || normalizeLang(input.language),
        };

        const { value: found } = await withCache(
          'browse_by_subject',
          { subject, moodQuery, alQuery, limit, recent, yearFrom, wantKorean, genre: hint.genre?.key ?? '' },
          async () => {
            // ★ 국내서는 국내 소스만. search_books 와 같은 이유입니다 —
            //   Open Library subject 브라우즈는 1880~1920년 영미 고전만 돌려줍니다
            //   (실측: subject=thriller → Treasure Island, Dracula).
            if (wantKorean) {
              const ko = await Promise.allSettled([
                searchAladin({ query: alQuery, key: alKey, limit, recent }),
                searchNlk({ query: alQuery, key: nlKey, limit, recent }),
              ]);
              const koFailures = logSettled('browse_by_subject.ko', ko, ['aladin', 'nlk']);
              const koGroups = ko.map(unwrap);
              const koBooks = koGroups.flat();
              if (koBooks.length) {
                const merged = mergeBooks(koGroups, limit, { preferRecent: recent, relevance });
                return { merged, failures: koFailures, sources: 'ko' };
              }
              // 폴백은 Google Books 만 씁니다. Open Library 는 한국어 질의에서
              // 「…연구」 같은 학술서를 돌려줘 오히려 품질을 떨어뜨립니다.
              log.info('국내 주제 탐색 0권 — Google Books 로 폴백', { alQuery, hasAladinKey: Boolean(alKey) });
              const fb = await Promise.allSettled([
                searchGoogleBooks({
                  query: buildQuery({ subject: hint.genre ? hint.genre.gbSubject : subject.replace(/_/g, ' ') }),
                  apiKey: gbKey, limit, language: 'ko',
                  orderBy: recent ? 'newest' : 'relevance',
                }),
              ]);
              const fbFailures = logSettled('browse_by_subject.fallback', fb, ['googleBooks']);
              const merged = mergeBooks(fb.map(unwrap), limit, { preferRecent: recent, relevance });
              return { merged, failures: [...koFailures, ...fbFailures], sources: 'fallback' };
            }

            const results = await Promise.allSettled([
              // 신간 모드에서는 subject 브라우즈(연도 필터 불가) 대신
              // 연도 범위를 넣을 수 있는 일반 검색을 씁니다.
              recent
                ? searchOpenLibrary({ query: subject.replace(/_/g, ' '), limit, yearFrom, yearTo })
                : browseSubject({ subject, limit }),
              moodQuery
                ? searchHardcover({
                    query: moodQuery, token: hcToken, limit,
                    sort: recent ? 'release_date_i:desc' : undefined,
                  })
                : Promise.resolve([]),
              // subject를 Google Books 문법으로도 한 번 던져서 커버리지 보강
              searchGoogleBooks({
                query: buildQuery({ subject: subject.replace(/_/g, ' ') }),
                apiKey: gbKey,
                limit,
                orderBy: recent ? 'newest' : 'relevance',
              }),
            ]);
            const failures = logSettled('browse_by_subject', results, ['openLibrary', 'hardcover', 'googleBooks']);
            const merged = mergeBooks(results.map(unwrap), limit, { preferRecent: recent, relevance });
            return { merged, failures };
          },
        );

        const books = found.merged ?? [];
        const label = `주제 "${subject}"${moodQuery ? ` / 무드 "${moodQuery}"` : ''}${
          hint.genre ? ` (장르 ${hint.genre.key})` : ''
        } 탐색 결과${recent ? ` (신간 우선, ${yearFrom}년 이후)` : ''}`;

        return {
          llmText: books.length
            ? header(books, label) + compactForLlm(books) + (recent ? recentCaveat(books) : '')
            : emptyGuidance({ label, failures: found.failures, wantKorean, secrets }),
          books,
          meta: { count: books.length, recent, genre: hint.genre?.key, durationMs: Date.now() - t0 },
        };
      }

      // ── 제목+저자 정확 조회 (LLM 이 지목한 책을 검증) ─────────
      case 'lookup_books': {
        const items = parseItems(input.items, 10);
        if (!items.length) {
          return {
            llmText:
              'items 가 비어 있거나 형식이 잘못되었다. [{title:"제목", author:"저자"}] 형태로 다시 호출하라.',
            books: [],
            meta: { count: 0 },
          };
        }

        const langHint = normalizeLang(input.language);

        const { value: found } = await withCache(
          'lookup_books',
          { items, langHint },
          async () => {
            // 책마다 병렬로 조회합니다. 6권 × 소스 3곳 = 최대 18회.
            // 순차로 돌리면 18 × 1초 = 18초로 에이전트 예산을 다 씁니다.
            const perItem = await Promise.all(
              items.map(async (it) => {
                const isKo = langHint === 'ko' || looksKorean(it.title, it.author);
                const q = [it.title, it.author].filter(Boolean).join(' ');

                // ★ 소스 라우팅 — 국내서와 해외서는 잘 아는 DB 가 다릅니다.
                //   국내서에 Hardcover 를 부르면 지연만 늘고 결과는 없습니다.
                const calls = isKo
                  ? [
                      // 국내서는 알라딘이 정확합니다. Open Library 는 부르지 않습니다 —
                      // 제목·저자로 조회해도 「…연구」 같은 학술서를 돌려줍니다.
                      searchAladin({ query: q, key: alKey, limit: 5 }),
                      // 국중은 제목·저자 전용 상세검색이 있습니다(f1/v1, f2/v2).
                      // 자유어 검색보다 정확해서 이 도구에 특히 잘 맞습니다.
                      lookupNlk({ title: it.title, author: it.author, key: nlKey, limit: 5 }),
                      // Google Books 는 제목·저자 전용 문법이 있어 국내서도 잡습니다.
                      searchGoogleBooks({
                        query: buildQuery({ title: it.title, author: it.author || undefined }),
                        apiKey: gbKey, limit: 5, language: 'ko',
                      }),
                    ]
                  : [
                      searchGoogleBooks({
                        query: buildQuery({ title: it.title, author: it.author || undefined }),
                        apiKey: gbKey, limit: 5,
                      }),
                      searchHardcover({ query: q, token: hcToken, limit: 5 }),
                      searchOpenLibrary({ query: q, limit: 5 }),
                    ];

                const settled = await Promise.allSettled(calls);
                logSettled(
                  'lookup_books',
                  settled,
                  isKo ? ['aladin', 'nlk', 'googleBooks'] : ['googleBooks', 'hardcover', 'openLibrary'],
                );

                // 소스별 결과를 먼저 병합해야 표지·평점·무드가 한 레코드에 모입니다.
                const candidates = mergeBooks(settled.map(unwrap), 10);
                const hit = pickBest(it, candidates);
                return { requested: it, isKo, hit };
              }),
            );

            const verified = [];
            const missing = [];
            for (const r of perItem) {
              if (r.hit) {
                verified.push({
                  ...r.hit.book,
                  // 어떤 요청으로 확인된 책인지 남깁니다 (디버깅·로그용)
                  matchedFor: r.requested.title,
                });
              } else {
                missing.push(r.requested);
              }
            }
            return { verified, missing };
          },
        );

        const verified = found.verified ?? [];
        const missing = found.missing ?? [];

        log.info('lookup_books', { asked: items.length, verified: verified.length, missing: missing.length });

        const lines = [];
        if (verified.length) {
          lines.push(`제목·저자 조회로 **확인된** 책 ${verified.length}권:`);
          lines.push(compactForLlm(verified));
        } else {
          lines.push('요청한 책을 하나도 확인하지 못했다.');
        }

        if (missing.length) {
          lines.push('');
          lines.push(
            `확인 실패 ${missing.length}권: ${missing.map((m) => `"${m.title}"${m.author ? `(${m.author})` : ''}`).join(', ')}`,
          );
          lines.push('이 책들은 도서 DB에서 찾지 못했다. **답변에서 언급하지 마라.**');
          lines.push('제목이 틀렸거나, 실제로 없는 책이거나, 해당 DB 키가 설정되지 않은 것이다.');
          const keyless = keylessSources(secrets);
          if (keyless.length) lines.push(`참고 — 사용 불가 소스: ${keyless.join(' / ')}`);
        }

        if (!verified.length) {
          lines.push('');
          lines.push('다른 책 제목으로 이 도구를 한 번 더 호출하거나, search_books 로 탐색하라.');
          lines.push('책을 지어내서 답변하지 마라.');
        }

        return {
          llmText: `${lines.join('\n')}\n`,
          books: verified,
          meta: { count: verified.length, asked: items.length, missing: missing.length, durationMs: Date.now() - t0 },
        };
      }

      // ── 무료 전자책 ─────────────────────────────────────────
      case 'find_free_ebooks': {
        const limit = clampLimit(input.limit, 6);
        const query = String(input.query || '').trim();
        const topic = String(input.topic || '').trim();
        const languages = String(input.language || 'en').trim();

        if (!query && !topic) {
          return {
            llmText: 'query 또는 topic 중 하나는 반드시 필요합니다. 다시 호출하세요.',
            books: [],
            meta: { count: 0 },
          };
        }

        const { value: result } = await withCache(
          'find_free_ebooks',
          { query, topic, languages, limit },
          async () => {
            // 1차: Gutendex (실제 EPUB/TXT 파일 링크를 주는 최선의 소스)
            const gutenberg = await searchGutendex({ query, topic, languages, limit });

            // 2차 폴백: gutendex.com이 죽어 있으면 Open Library의 무료 전문 검색으로 대체.
            // 기능을 통째로 잃는 것보다 archive.org 뷰어 링크라도 주는 게 낫습니다.
            const primary = gutenberg.length
              ? gutenberg
              : await searchFreeFullText({ query: query || undefined, subject: topic || undefined, limit });

            if (!primary.length) return { books: [], source: 'none' };

            // Gutenberg/IA 데이터에는 평점·무드가 없으므로 Hardcover로 보강해
            // "왜 이 책인지" 설명할 근거를 만든다
            const enrich = await Promise.allSettled(
              primary.slice(0, 4).map((b) =>
                searchHardcover({ query: `${b.title} ${b.authors[0] ?? ''}`.trim(), token: hcToken, limit: 2 }),
              ),
            );
            // 보강 실패가 로그에 남지 않아 원인 추적이 안 되던 구간
            logSettled('find_free_ebooks.enrich', enrich, primary.slice(0, 4).map((b) => `hardcover:${b.title.slice(0, 20)}`));
            return {
              books: mergeBooks([primary, ...enrich.map(unwrap)], limit),
              source: gutenberg.length ? 'gutenberg' : 'archive.org',
            };
          },
        );

        const books = result.books;
        const sourceLabel = result.source === 'gutenberg'
          ? '무료로 읽을 수 있는 책 (Project Gutenberg)'
          : '무료로 읽을 수 있는 책 (Internet Archive — Gutenberg 일시 장애로 대체 조회)';

        return {
          llmText:
            header(books, sourceLabel) +
            compactForLlm(books) +
            (books.length ? '\n(무료 열람/다운로드 링크는 화면 카드에 자동 표시됩니다. URL을 답변에 직접 쓰지 마세요.)' : ''),
          books,
          meta: { count: books.length, source: result.source, durationMs: Date.now() - t0 },
        };
      }

      // ── 단권 상세 ───────────────────────────────────────────
      case 'get_book_detail': {
        const isbn13 = toIsbn13(input.isbn);
        const title = String(input.title || '').trim();
        const author = String(input.author || '').trim();

        if (!isbn13 && !title) {
          return { llmText: 'isbn 또는 title 중 하나는 반드시 필요합니다.', books: [], meta: { count: 0 } };
        }

        const plainQuery = isbn13 || [title, author].filter(Boolean).join(' ');

        const { value: books } = await withCache('get_book_detail', { isbn13, title, author }, async () => {
          const results = await Promise.allSettled([
            searchGoogleBooks({
              query: isbn13 ? `isbn:${isbn13}` : buildQuery({ title, author }),
              apiKey: gbKey,
              limit: 3,
            }),
            searchOpenLibrary({ query: plainQuery, limit: 3 }),
            searchHardcover({ query: plainQuery, token: hcToken, limit: 3 }),
            searchGutendex({ query: title || undefined, limit: 3 }),
            // 한글 제목이거나 ISBN 조회면 국내 도서일 가능성이 있어 함께 봅니다.
            hasHangul(plainQuery) || isbn13
              ? searchAladin({ query: plainQuery, key: alKey, limit: 3 })
              : Promise.resolve([]),
          ]);
          logSettled('get_book_detail', results, ['googleBooks', 'openLibrary', 'hardcover', 'gutendex', 'aladin']);
          return mergeBooks(results.map(unwrap), 2);
        });

        if (!books.length) {
          return {
            llmText: `"${plainQuery}"에 해당하는 책을 4개 DB에서 찾지 못했습니다. 제목 표기를 바꿔 다시 시도하거나, 사용자에게 확인을 요청하세요.`,
            books: [],
            meta: { count: 0 },
          };
        }

        const b = books[0];
        const detail = [
          `제목: ${b.title}${b.subtitle ? `: ${b.subtitle}` : ''}`,
          `저자: ${b.authors.join(', ')}`,
          b.year ? `출판: ${b.year}년${b.publisher ? ` / ${b.publisher}` : ''}` : null,
          b.pageCount ? `분량: ${b.pageCount}페이지` : null,
          b.rating ? `평점: ${b.rating.value}/5 (${b.rating.count}명, ${b.rating.source})` : null,
          b.genres?.length ? `장르: ${b.genres.join(', ')}` : null,
          b.moods?.length ? `무드: ${b.moods.join(', ')}` : null,
          b.contentWarnings?.length ? `콘텐츠 경고: ${b.contentWarnings.join(', ')}` : null,
          b.series ? `시리즈: ${b.series}${b.seriesPosition ? ` ${b.seriesPosition}권` : ''}` : null,
          b.isbn13?.length ? `ISBN-13: ${b.isbn13.join(', ')}` : null,
          b.hasAudiobook ? '오디오북 있음' : null,
          b.freeEbook ? `무료 전문 제공: ${b.freeEbook.source}` : null,
          `데이터 출처: ${b.sources.join(' + ')}`,
          b.description ? `\n소개: ${b.description}` : null,
        ]
          .filter(Boolean)
          .join('\n');

        return { llmText: detail, books, meta: { count: books.length, durationMs: Date.now() - t0 } };
      }

      default:
        return {
          llmText: `알 수 없는 도구: ${name}. 사용 가능한 도구: ${Object.keys(TOOL_LABELS).join(', ')}`,
          books: [],
          meta: { error: 'unknown_tool' },
        };
    }
  } catch (err) {
    // 도구가 터져도 대화는 계속되어야 한다.
    // LLM에게 실패 사실을 알려주면 스스로 다른 도구를 시도하거나 사용자에게 되묻는다.
    log.error('도구 실행 실패', { tool: name, input, err });
    return {
      llmText: `도구 "${name}" 실행 중 오류가 발생했습니다: ${err.message}. 다른 검색어나 다른 도구로 시도하거나, 사용자에게 조건을 다시 물어보세요.`,
      books: [],
      meta: { error: err.message, durationMs: Date.now() - t0 },
    };
  }
}

// ────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────

function unwrap(settled) {
  return settled.status === 'fulfilled' && Array.isArray(settled.value) ? settled.value : [];
}

/**
 * 소스별 성공·실패를 로그로 남기고, 0권으로 끝난 소스 목록을 돌려줍니다.
 *
 * 반환값을 쓰는 이유: 결과가 0권일 때 LLM 에게 **왜** 0권인지 알려줘야 합니다.
 * 그냥 "결과 없음" 만 주면 LLM 이 검색어를 임의로 바꿔 재시도하면서
 * 주제를 벗어납니다 (실측: "한국 스릴러" 0권 → "Korea" 재검색 → 한국사 책).
 */
function logSettled(tool, results, names) {
  /** @type {{source: string, reason: string}[]} */
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const reason = String(r.reason?.message ?? r.reason);
      log.warn('소스 실패 (나머지로 진행)', { tool, source: names[i], reason });
      failures.push({ source: names[i], reason });
    } else {
      const count = Array.isArray(r.value) ? r.value.length : 0;
      log.debug('소스 성공', { tool, source: names[i], count });
      if (count === 0) failures.push({ source: names[i], reason: '0권' });
    }
  });
  return failures;
}

function header(books, label) {
  if (!books.length) return `${label}: 결과 없음.\n`;
  return `${label} (${books.length}권, 실제 DB에서 확인된 책):\n`;
}

/** 검색 조건을 사람이 읽을 수 있게 (LLM 이 무엇으로 찾았는지 알아야 답변이 정확합니다) */
function describeSearch({ hint, language, recent, yearFrom }) {
  const bits = [];
  if (hint?.keywords) bits.push(`키워드 "${hint.keywords}"`);
  if (hint?.genre) bits.push(`장르 ${hint.genre.key}`);
  if (language) bits.push(`언어 ${language}`);
  if (!bits.length && hint?.rawQuery) bits.push(`"${hint.rawQuery}"`);
  return `${bits.join(' · ')} 검색 결과${recent ? ` (신간 우선, ${yearFrom}년 이후)` : ''}`;
}

/** 키가 없어 사실상 동작하지 않는 소스 목록 */
function keylessSources(secrets = {}) {
  const out = [];
  if (!secrets.GOOGLE_BOOKS_API_KEY) out.push('Google Books(키 없음 — 익명 쿼터는 이미 소진된 상태일 수 있음)');
  if (!secrets.HARDCOVER_TOKEN) out.push('Hardcover(토큰 없음 — 무드·평점 사용 불가)');
  if (!secrets.ALADIN_TTB_KEY) out.push('알라딘(키 없음 — 국내 도서 검색 불가)');
  return out;
}

/**
 * 0권일 때 LLM 에게 주는 안내.
 *
 * ★ 이 문구가 주제 이탈을 막는 핵심입니다.
 *   전에는 "결과 없음." 한 줄만 줬습니다. 그러면 LLM 은 스스로 판단해서
 *   검색어를 영어 일반명사로 바꿔 재시도했고("한국 스릴러" → "Korea"),
 *   Open Library 가 한국사·여행서를 돌려줘 전혀 다른 주제의 카드가 나왔습니다.
 *
 *   그래서 "무엇을 하지 말아야 하는지" 를 명시합니다.
 */
function emptyGuidance({ label, failures = [], wantKorean, secrets = {} }) {
  const keyless = keylessSources(secrets);
  const lines = [`${label}: 결과 0권.`];

  if (failures.length) {
    lines.push(`소스별 상태: ${failures.map((f) => `${f.source}=${f.reason}`).join(', ')}`);
  }
  if (keyless.length) {
    lines.push(`사용 불가 소스: ${keyless.join(' / ')}`);
  }

  lines.push('');
  lines.push('다음 지시를 반드시 따르라:');
  lines.push('- 검색어를 지역명(한국/Korea/Korean)으로 바꿔 재검색하지 마라.');
  lines.push('  그렇게 하면 요청한 장르가 아니라 그 지역을 **다룬** 책(역사·정치·여행서)이 나온다.');
  lines.push('- 같은 뜻의 다른 말로 두 번 이상 재검색하지 마라. 결과가 좋아지지 않는다.');

  if (wantKorean && !secrets.ALADIN_TTB_KEY) {
    lines.push('- 국내 도서 DB(알라딘) 키가 설정되지 않아 한국 도서를 검색할 수 없다.');
    lines.push('  추측으로 책 제목을 만들어내지 말고, 지금 한국 도서를 찾을 수 없다고');
    lines.push('  사용자에게 솔직히 알리고 영어권 도서로 대안을 제시할지 물어라.');
  } else {
    lines.push('- 한 번 더 시도할 수 있다면, 장르어만 남기고(예: "스릴러") 지역어를 빼서 호출하라.');
    lines.push('- 그래도 0권이면 결과가 없다고 사용자에게 알려라. 책을 지어내지 마라.');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * recent / yearFrom 입력을 정규화.
 * recent=true 면 "최근 2년"을 기본 범위로 잡습니다(올해 신간이 아직 적을 수 있으므로).
 */
function recencyOptions(input) {
  const now = new Date().getFullYear();
  const explicit = Number(input?.yearFrom);
  const hasExplicit = Number.isFinite(explicit) && explicit > 1500 && explicit <= now + 1;
  const recent = Boolean(input?.recent) || hasExplicit;

  if (!recent) return { recent: false, yearFrom: undefined, yearTo: undefined };
  return {
    recent: true,
    yearFrom: hasExplicit ? Math.trunc(explicit) : now - 1,
    // 내년까지 허용(예약 출간). 그 이상은 메타데이터 오류로 보고 자릅니다.
    yearTo: now + 1,
  };
}

/**
 * 신간 검색의 한계를 LLM에게 알려서, 결과가 부실할 때 사용자에게
 * 솔직히 말하고 조건을 바꿔 제안하도록 유도합니다.
 */
function recentCaveat(books) {
  const now = new Date().getFullYear();
  const fresh = books.filter((b) => b.year && b.year >= now - 1).length;
  if (!books.length) {
    return (
      '\n(신간 검색 결과가 없습니다. 연도 조건을 1~2년 더 넓히거나, 검색어를 더 일반적인 말로 바꿔 다시 호출하세요.'
      + ' 제목을 추측해서 지어내지 마세요.)'
    );
  }
  if (fresh === 0) {
    return (
      `\n(주의: ${now - 1}년 이후 출간된 책이 결과에 없습니다. 사용자에게 "요청하신 최신 도서는 아직 데이터베이스 등재가 적다"고`
      + ' 솔직히 알리고, 위 목록은 관련도가 높은 책으로 제시하세요.)'
    );
  }
  return `\n(위 결과 중 ${fresh}권이 ${now - 1}년 이후 출간입니다. 신간 여부를 언급할 때 출간연도를 함께 밝히세요.)`;
}

/** 'korean' / 'Korean' / 'ko-KR' 같은 값을 ISO 639-1로 정리 */
function normalizeLang(v) {
  if (!v) return undefined;
  const s = String(v).trim().toLowerCase();
  const map = { korean: 'ko', english: 'en', japanese: 'ja', chinese: 'zh', french: 'fr', german: 'de', spanish: 'es' };
  if (map[s]) return map[s];
  const two = s.slice(0, 2);
  return /^[a-z]{2}$/.test(two) ? two : undefined;
}
