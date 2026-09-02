import React, { useMemo } from 'react';
import { useI18n } from '../i18n.js';

/**
 * 메시지 말풍선.
 *
 * 마크다운 렌더링을 라이브러리 없이 직접 합니다. 이유:
 *  1) 의존성 감소 → 번들 크기 축소 (react-markdown + remark는 100KB 이상)
 *  2) XSS 안전 — dangerouslySetInnerHTML을 쓰지 않고 React 엘리먼트만 만듭니다.
 *     LLM 응답은 결국 외부 데이터(도서 API 텍스트)의 영향을 받으므로
 *     HTML을 그대로 주입하면 안 됩니다.
 *
 * ★ 지원 문법은 backend/src/prompt.mjs 가 모델에게 지시하는 문법과
 *   반드시 일치해야 합니다. 전에는 프롬프트가 "## 헤딩을 써라"고 지시하는데
 *   이 파서에 헤딩 분기가 없어서 화면에 '## 지금 바로...' 가 그대로 나왔습니다.
 *   문법을 추가하거나 뺄 때는 양쪽을 같이 고치세요.
 *
 * 지원 블록: 헤딩(#~######), 문단, 불릿 목록, 번호 목록, 인용문(>),
 *            수평선(---), 표(|a|b|), 코드블록(```)
 * 지원 인라인: **굵게**, *기울임*, `코드`, ~~취소선~~, [링크](url)
 */
export default function MessageBubble({ role, text, streaming }) {
  const { t } = useI18n();
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const isUser = role === 'user';
  const lastIndex = blocks.length - 1;

  return (
    <div className={`msg ${isUser ? 'msg--user' : 'msg--bot'}`}>
      {!isUser && <div className="msg__avatar" aria-hidden="true" />}
      <div className="msg__body">
        <span className="sr-only">{isUser ? t('msg.user') : t('msg.bot')}</span>
        {blocks.map((block, i) => (
          <Block key={i} block={block} cursor={streaming && i === lastIndex} />
        ))}
        {streaming && !blocks.length && <span className="cursor" aria-hidden="true" />}
      </div>
    </div>
  );
}

/** 커서 — 스트리밍 중 마지막 블록 끝에 붙습니다 */
const Cursor = () => <span className="cursor" aria-hidden="true" />;

function Block({ block, cursor }) {
  switch (block.type) {
    case 'heading': {
      // 페이지는 h1(제목) · h2(섹션) · h4(책 카드 제목)를 씁니다.
      // 답변 안의 소제목은 그 사이에 들어가야 개요가 어긋나지 않습니다.
      const Tag = block.level <= 2 ? 'h3' : block.level === 3 ? 'h4' : 'h5';
      return (
        <Tag className={`msg__h msg__h--${block.level <= 2 ? 1 : 2}`}>
          {renderInline(block.text)}
          {cursor && <Cursor />}
        </Tag>
      );
    }

    case 'hr':
      return <hr className="msg__hr" />;

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          className={`msg__list${block.ordered ? ' msg__list--ordered' : ''}`}
          start={block.ordered && block.start !== 1 ? block.start : undefined}
        >
          {block.items.map((item, j) => (
            <li key={j}>
              {renderLines(item)}
              {cursor && j === block.items.length - 1 && <Cursor />}
            </li>
          ))}
        </Tag>
      );
    }

    case 'quote':
      return (
        <blockquote className="msg__quote">
          {renderLines(block.lines)}
          {cursor && <Cursor />}
        </blockquote>
      );

    case 'code':
      // 코드블록 안은 서식을 적용하지 않습니다 (마크다운 규칙)
      return (
        <pre className="msg__pre">
          <code>{block.lines.join('\n')}</code>
        </pre>
      );

    case 'table':
      return (
        <div className="msg__table-wrap">
          <table className="msg__table">
            {block.head && (
              <thead>
                <tr>
                  {block.head.map((cell, j) => (
                    <th key={j} scope="col">
                      {renderInline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell, k) => (
                    <td key={k}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    default:
      return (
        <p className="msg__p">
          {renderLines(block.lines)}
          {cursor && <Cursor />}
        </p>
      );
  }
}

/* ────────────────────────────────────────────────────────────
   블록 파싱
   ──────────────────────────────────────────────────────────── */

const RE_FENCE = /^\s*```+\s*([\w+-]*)\s*$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_HEADING = /^\s*(#{1,6})\s+(.*)$/;
const RE_TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const RE_TABLE_SEP = /^[\s|:-]+$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
// 불릿은 그룹1, 번호는 그룹2, 내용은 그룹3
const RE_LIST = /^\s*(?:([-*•·])|(\d{1,3})[.)])\s+(.*)$/;

/**
 * 텍스트를 블록 배열로 나눈다.
 *
 * 문단 안의 단일 줄바꿈은 보존합니다(lines 배열). 전에는 join(' ') 으로
 * 합쳤는데, 프롬프트가 지시하는
 *     《제목》 — 저자 (연도)
 *     한 줄 이유
 * 형식이 한 줄로 뭉쳐서 읽을 수 없었습니다.
 */
function parseBlocks(text) {
  if (!text) return [];
  const lines = String(text).split('\n');
  const blocks = [];

  let para = null; // string[]
  let list = null; // { ordered, start, items: string[][] }
  let quote = null; // string[]
  let fence = null; // { lang, lines: string[] }
  let table = null; // string[][] (아직 헤더/본문 구분 전)

  const flushPara = () => {
    if (para?.length) blocks.push({ type: 'p', lines: para });
    para = null;
  };
  const flushList = () => {
    if (list?.items.length) {
      blocks.push({ type: 'list', ordered: list.ordered, start: list.start, items: list.items });
    }
    list = null;
  };
  const flushQuote = () => {
    if (quote?.length) blocks.push({ type: 'quote', lines: quote });
    quote = null;
  };
  const flushTable = () => {
    if (table?.length) blocks.push(buildTable(table));
    table = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
    flushTable();
  };

  for (const raw of lines) {
    // ── 코드블록 안 — 다른 규칙을 전부 무시합니다 ──────────────
    if (fence) {
      if (RE_FENCE.test(raw)) {
        blocks.push({ type: 'code', lang: fence.lang, lines: fence.lines });
        fence = null;
      } else {
        fence.lines.push(raw);
      }
      continue;
    }

    const line = raw.trimEnd();

    const fenceOpen = RE_FENCE.exec(line);
    if (fenceOpen) {
      flushAll();
      fence = { lang: fenceOpen[1] || '', lines: [] };
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    // 수평선은 목록보다 먼저 봅니다 ('---' 가 불릿으로 오해되지 않게)
    if (RE_HR.test(line)) {
      flushAll();
      blocks.push({ type: 'hr' });
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const tableRow = RE_TABLE_ROW.exec(line);
    if (tableRow) {
      flushPara();
      flushList();
      flushQuote();
      if (!table) table = [];
      table.push(splitRow(tableRow[1]));
      continue;
    }

    const quoteLine = RE_QUOTE.exec(line);
    if (quoteLine) {
      flushPara();
      flushList();
      flushTable();
      if (!quote) quote = [];
      quote.push(quoteLine[1]);
      continue;
    }

    const listItem = RE_LIST.exec(line);
    if (listItem) {
      flushPara();
      flushQuote();
      flushTable();
      const ordered = listItem[2] !== undefined;
      // 불릿 → 번호로 바뀌면 목록을 끊습니다
      if (list && list.ordered !== ordered) flushList();
      if (!list) {
        list = { ordered, start: ordered ? Number(listItem[2]) : 1, items: [] };
      }
      list.items.push([listItem[3]]);
      continue;
    }

    // 목록 항목 바로 아래의 들여쓴 줄은 그 항목에 이어 붙입니다
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1].push(line.trim());
      continue;
    }

    flushList();
    flushQuote();
    flushTable();
    if (!para) para = [];
    para.push(line.trim());
  }

  // 닫히지 않은 코드블록도 버리지 않고 내보냅니다 (스트리밍 중 흔합니다)
  if (fence) blocks.push({ type: 'code', lang: fence.lang, lines: fence.lines });
  flushAll();
  return blocks;
}

/** '| a | b |' 의 내부를 셀 배열로 */
function splitRow(inner) {
  return inner.split('|').map((c) => c.trim());
}

/**
 * 표 행 묶음을 헤더/본문으로 정리한다.
 * 두 번째 행이 구분선(|---|---|)이면 첫 행을 헤더로 씁니다.
 */
function buildTable(rows) {
  const isSep = (row) => row.length > 0 && row.every((c) => c !== '' && RE_TABLE_SEP.test(c));
  if (rows.length >= 2 && isSep(rows[1])) {
    return { type: 'table', head: rows[0], rows: rows.slice(2) };
  }
  // 구분선이 없으면 헤더 없는 표로 취급합니다
  return { type: 'table', head: null, rows: rows.filter((r) => !isSep(r)) };
}

/* ────────────────────────────────────────────────────────────
   인라인 서식
   ──────────────────────────────────────────────────────────── */

/**
 * 여러 줄을 <br> 로 이어 렌더한다.
 * @param {string|string[]} lines
 */
function renderLines(lines) {
  const arr = Array.isArray(lines) ? lines : [lines];
  return arr.map((line, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {renderInline(line)}
    </React.Fragment>
  ));
}

// 캡처 그룹은 전체를 감싸는 것 하나뿐이어야 합니다.
// String.split() 이 모든 캡처 그룹을 결과에 끼워 넣기 때문입니다.
// 순서가 중요합니다: 코드 → 굵게 → 취소선 → 링크 → 기울임
//   · 코드가 먼저여야 `**x**` 안의 별표가 서식으로 먹히지 않습니다
//   · 굵게가 기울임보다 먼저여야 '**' 가 '*' 로 잘리지 않습니다
const RE_INLINE =
  /(`[^`\n]+`|\*\*[^\n]+?\*\*|~~[^~\n]+?~~|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;

const RE_LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

/**
 * href 를 검증한다. http/https 만 허용합니다.
 *
 * 왜 필요한가: 답변 텍스트는 외부 도서 API 데이터의 영향을 받습니다.
 * 검증 없이 [클릭](javascript:...) 을 앵커로 만들면 클릭 한 번으로
 * 스크립트가 실행됩니다. 허용되지 않는 스킴은 링크로 만들지 않고
 * 원문 그대로 글자로 보여줍니다.
 */
function safeHref(url) {
  const trimmed = String(url).trim();
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
}

/** 인라인 서식을 React 엘리먼트 배열로 변환 (HTML 주입 없음) */
function renderInline(text) {
  if (!text) return null;
  const parts = String(text)
    .split(RE_INLINE)
    .filter((p) => p !== '' && p !== undefined);

  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) {
      return <del key={i}>{part.slice(2, -2)}</del>;
    }
    const link = RE_LINK.exec(part);
    if (link) {
      const href = safeHref(link[2]);
      // 스킴이 허용되지 않으면 앵커로 만들지 않고 원문을 그대로 보여줍니다
      if (!href) return <React.Fragment key={i}>{part}</React.Fragment>;
      return (
        <a key={i} href={href} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
