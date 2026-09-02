import React, { useEffect, useMemo, useRef } from 'react';
import MessageBubble from './MessageBubble.jsx';
import BookCard from './BookCard.jsx';
import ToolActivity from './ToolActivity.jsx';
import Thinking from './Thinking.jsx';
import Feedback from './Feedback.jsx';
import { useI18n } from '../i18n.js';

/** 질문을 올릴 때 위에 남길 여백 (px) */
const ANCHOR_PAD = 10;

/**
 * 대화 영역.
 *
 * 스크롤 규칙은 딱 하나입니다.
 *   **질문을 보낸 순간, 그 질문을 대화창 위쪽으로 한 번만 올린다.**
 *   그 뒤에는 아무것도 건드리지 않습니다. 답변과 책 카드는 아래로 쌓이고,
 *   더 읽고 싶으면 사용자가 스크롤합니다.
 *
 * 하지 않는 것 (둘 다 실제로 문제를 일으켰습니다)
 *
 *   1) 새 내용이 올 때마다 맨 아래로 내리지 않습니다.
 *      답변 아래에 책 카드가 붙는 구조라, 맨 아래로 가면 화면에 보이는 건
 *      카드 목록의 끝입니다. 답변 글은 위로 밀려 사라져서 매번 올려봐야 했습니다.
 *
 *   2) 아래에 여유 공간(spacer)을 넣지 않습니다.
 *      "질문을 화면 맨 위까지 정확히 올리려면 아래에 빈 공간이 필요하다"고
 *      계산해서 넣었는데, 첫 질문에서는 콘텐츠가 화면보다 작아 부족분이
 *      474px 로 계산되었습니다. 결과는 질문 아래로 화면 하나만큼의 빈 여백이었고,
 *      사용자에게는 "화면이 하얗게 됐다"로 보였습니다.
 *      게다가 그 높이를 상태로 들고 의존성에 넣었기 때문에 스트리밍 중
 *      렌더가 반복될 위험도 있었습니다.
 *      → 콘텐츠가 짧으면 질문이 올라갈 수 있는 만큼만 올라갑니다. 그걸로 충분합니다.
 *
 * 상태(useState)를 쓰지 않는 것이 핵심입니다. 스크롤 위치는 DOM 값이라
 * 상태로 관리하면 렌더 순환에 빠집니다.
 */
export default function ChatWindow({ turns, streaming, error }) {
  const { t } = useI18n();
  const scrollRef = useRef(null);
  const anchorRef = useRef(null);    // 마지막 사용자 질문의 DOM
  const anchoredId = useRef(null);   // 이미 올려준 질문 id (중복 실행 방지)

  const lastUserId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].role === 'user') return turns[i].id;
    }
    return null;
  }, [turns]);

  // 새 질문이 생겼을 때 딱 한 번 실행됩니다.
  // 의존성이 lastUserId 하나뿐이라 스트리밍 중에는 다시 돌지 않습니다.
  useEffect(() => {
    if (!lastUserId || anchoredId.current === lastUserId) return;
    anchoredId.current = lastUserId;

    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;

    // 컨테이너 기준의 질문 위치.
    // offsetTop 은 기준 조상에 따라 값이 달라지므로 rect 차이로 구합니다.
    // scrollIntoView 를 쓰지 않는 이유: 바깥 페이지까지 움직일 수 있습니다.
    const top =
      anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = Math.max(0, top - ANCHOR_PAD);
  }, [lastUserId]);

  return (
    <div className="chat" ref={scrollRef}>
      <div className="chat__inner">
        {turns.map((turn) => (
          <div
            className="turn"
            key={turn.id}
            /* 마지막 사용자 질문에만 ref 를 걸어 스크롤 기준으로 씁니다 */
            ref={turn.id === lastUserId ? anchorRef : null}
          >
            {turn.role === 'user' ? (
              <MessageBubble role="user" text={turn.text} />
            ) : (
              <>
                <ToolActivity activities={turn.activities} />

                {/* 대기 구간. 버퍼 응답이라 이 시간이 10~25초까지 갑니다.
                    Thinking 이 경과 시간과 단계를 보여줍니다 — 자세한 근거는
                    Thinking.jsx 위쪽 주석 참고. */}
                {turn.streaming && !turn.text && !turn.activities?.length && <Thinking />}

                {/* 순서: 진행표시 → 답변 텍스트 → 책 카드
                    답변을 먼저 읽고 그 근거인 책 목록을 아래에서 확인하는 흐름입니다. */}
                {(turn.text || (turn.streaming && turn.activities?.length > 0)) && (
                  <MessageBubble role="assistant" text={turn.text} streaming={turn.streaming} />
                )}

                {/* 책 카드는 답변 아래에 배치 — 답변을 읽고 근거를 확인하는 순서 */}
                {turn.books?.length > 0 && (
                  <section className="cards" aria-label={t('chat.cardsAria', { count: turn.books.length })}>
                    {turn.books.map((b) => (
                      <BookCard key={b.id || b.title} book={b} />
                    ))}
                  </section>
                )}

                {turn.notices?.map((n, i) => (
                  <p className="notice" key={i}>
                    {n}
                  </p>
                ))}

                {turn.error && (
                  <div className="alert" role="alert">
                    <strong>{t('chat.errorTitle')}</strong>
                    <p>{turn.error}</p>
                  </div>
                )}

                {/* 평가는 답변이 끝난 뒤에만 묻습니다.
                    쓰는 중에 물어보면 아직 읽지도 않은 것을 평가하게 됩니다.
                    오류가 난 턴에도 묻지 않습니다 — 평가할 답변이 없습니다. */}
                {!turn.streaming && !turn.error && turn.logRef && <Feedback logRef={turn.logRef} />}
              </>
            )}
          </div>
        ))}

        {error && (
          <div className="alert" role="alert">
            <strong>{t('chat.connErrorTitle')}</strong>
            <p>{error}</p>
          </div>
        )}

        {/* 스크린 리더에게 스트리밍 상태를 알림.
            응답 텍스트 전체를 aria-live로 읽으면 글자마다 다시 읽어서 소음이 됩니다.
            그래서 상태 문구만 알립니다. */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {streaming ? t('chat.writing') : ''}
        </div>
      </div>
    </div>
  );
}
