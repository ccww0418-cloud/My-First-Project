import React, { useCallback, useEffect, useRef, useState } from 'react';
import ChatWindow from './components/ChatWindow.jsx';
import Composer from './components/Composer.jsx';
import SuggestionChips from './components/SuggestionChips.jsx';
import SavedPanel from './components/SavedPanel.jsx';
import { useSavedBooks } from './lib/savedBooks.js';
import { streamChat, fetchConfig, getSessionId, setSessionId, clearSession } from './api.js';
import { useI18n, syncDocumentLang, SUPPORTED_LANGS, LANG_NAMES, formatDecimal, formatInt } from './i18n.js';

/**
 * 앱 상태 구조
 *
 * turns: 대화 턴 배열
 *   { id, role:'user',      text }
 *   { id, role:'assistant', text, books[], activities[], notices[], streaming, error, usage }
 *
 * 백엔드 SSE 이벤트를 마지막 assistant 턴에 누적하는 방식입니다.
 */

/**
 * 테마 — 기본은 밝은 한지 테마입니다.
 *
 * prefers-color-scheme 을 자동으로 따르지 않는 이유:
 *   OS가 다크 모드인 사용자도 이 서비스는 밝게 보게 하려는 의도적 선택입니다
 *   (한지·단청 팔레트가 밝은 배경에서 의도대로 보입니다).
 *   대신 토글을 제공하고 선택을 localStorage 에 기억합니다.
 *
 * OS 설정을 따르게 하려면 initialTheme() 의 첫 return 을
 *   window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
 * 로 바꾸면 됩니다.
 */
const THEME_KEY = 'bookbot.theme';

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* 시크릿 모드 등에서 접근 불가 */
  }
  return 'light';
}

/**
 * /api/config 호출이 실패했을 때 쓸 예시 질문.
 * 정상 경로에서는 백엔드가 언어에 맞는 목록을 내려줍니다.
 */
const FALLBACK_SUGGESTIONS = {
  en: [
    "I've been drained lately. Any comforting novel?",
    'Recommend a classic I can read for free right now',
    'Find me a mystery thriller with a strong twist',
  ],
  ko: [
    '요즘 좀 지쳤어요. 마음이 편해지는 소설 있을까요?',
    '무료로 지금 바로 읽을 수 있는 고전 추천해줘',
    '반전이 강한 미스터리 스릴러 찾아줘',
  ],
};

let seq = 0;
const nextId = () => `t${++seq}`;

export default function App() {
  const { t, lang, setLang } = useI18n();
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState(() => FALLBACK_SUGGESTIONS[lang] ?? FALLBACK_SUGGESTIONS.en);
  // 입력 글자 상한. 0 이면 Composer 가 자기 폴백을 씁니다.
  // 백엔드가 검증에 쓰는 값과 어긋나지 않도록 서버에서 받아옵니다.
  const [maxChars, setMaxChars] = useState(0);
  const [stats, setStats] = useState(null);
  const [theme, setTheme] = useState(initialTheme);

  /** 읽을 목록을 보고 있는지. 대화 상태는 그대로 남아 있어 닫으면 복귀합니다. */
  const [showSaved, setShowSaved] = useState(false);
  const savedBooks = useSavedBooks();

  // data-theme 속성으로 CSS 변수를 전환합니다 (styles.css 의 [data-theme='dark'])
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 무시 */
    }
  }, [theme]);

  const abortRef = useRef(null);

  // 예시 질문을 백엔드에서 가져온다 (실패하면 폴백 사용).
  // lang 이 바뀌면 다시 불러와야 칩 문구도 함께 바뀝니다.
  useEffect(() => {
    let alive = true;
    setSuggestions(FALLBACK_SUGGESTIONS[lang] ?? FALLBACK_SUGGESTIONS.en);
    fetchConfig(lang).then((cfg) => {
      if (!alive) return;
      if (cfg.suggestions?.length) setSuggestions(cfg.suggestions);
      if (Number(cfg.maxMessageChars) > 0) setMaxChars(Number(cfg.maxMessageChars));
    });
    return () => {
      alive = false;
    };
  }, [lang]);

  // <html lang> 을 UI 언어와 동기화 (스크린리더 발음)
  useEffect(() => {
    syncDocumentLang();
  }, [lang]);

  /** 마지막 assistant 턴을 갱신하는 헬퍼 */
  const patchLastBotTurn = useCallback((patch) => {
    setTurns((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].role === 'assistant') {
          next[i] = typeof patch === 'function' ? patch(next[i]) : { ...next[i], ...patch };
          break;
        }
      }
      return next;
    });
  }, []);

  const send = useCallback(
    async (rawMessage) => {
      const message = rawMessage.trim();
      if (!message || busy) return;

      // 목록을 보다가 예시 질문을 누른 경우 — 답변이 보이도록 대화로 돌아옵니다.
      setShowSaved(false);
      setError('');
      setInput('');
      setBusy(true);
      setStats(null);

      const botId = nextId();
      setTurns((prev) => [
        ...prev,
        { id: nextId(), role: 'user', text: message },
        {
          id: botId,
          role: 'assistant',
          text: '',
          books: [],
          activities: [],
          notices: [],
          streaming: true,
          error: null,
          // done 이벤트에서 채워집니다. 평가 버튼 표시 여부를 결정합니다.
          logRef: null,
        },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      // 무엇을 받았는지 추적 — 아무것도 못 받고 끝나는 경우를 감지하기 위함.
      // (이게 없으면 빈 응답일 때 화면에 아무것도 표시되지 않아 진단이 불가능합니다)
      const received = { events: 0, deltas: 0, error: false, done: false, firstByteMs: null };
      const t0 = Date.now();

      // 서버가 응답을 주지 않고 매달려 있는 경우를 대비한 클라이언트 타임아웃.
      // Lambda 타임아웃(90초) + 여유를 둡니다.
      const timeoutId = setTimeout(() => {
        if (!received.done) controller.abort(new Error('client-timeout'));
      }, 100_000);

      try {
        await streamChat({
          message,
          sessionId: getSessionId(),
          signal: controller.signal,
          onEvent: (e) => {
            received.events += 1;
            if (received.firstByteMs === null) received.firstByteMs = Date.now() - t0;
            switch (e.type) {
              case 'session':
                setSessionId(e.sessionId);
                break;

              case 'tool_start':
                patchLastBotTurn((t) => ({
                  ...t,
                  activities: [
                    ...t.activities,
                    {
                      id: `${e.name}-${t.activities.length}`,
                      name: e.name,
                      label: e.label || e.name,
                      // 어떤 검색어로 찾는지 보여주면 신뢰감이 올라갑니다
                      query: e.input?.query || e.input?.subject || e.input?.title || e.input?.topic || '',
                      done: false,
                    },
                  ],
                }));
                break;

              case 'tool_end':
                patchLastBotTurn((t) => {
                  const activities = [...t.activities];
                  // 같은 이름의 미완료 항목 중 가장 마지막을 완료 처리
                  for (let i = activities.length - 1; i >= 0; i -= 1) {
                    if (activities[i].name === e.name && !activities[i].done) {
                      activities[i] = { ...activities[i], done: true, count: e.count, ms: e.ms };
                      break;
                    }
                  }
                  return { ...t, activities };
                });
                break;

              case 'books':
                patchLastBotTurn((t) => {
                  // 중복 방지 (여러 도구가 같은 책을 반환할 수 있음)
                  const seen = new Set(t.books.map((b) => b.id));
                  const fresh = (e.items ?? []).filter((b) => !seen.has(b.id));
                  return { ...t, books: [...t.books, ...fresh] };
                });
                break;

              case 'delta':
                received.deltas += 1;
                patchLastBotTurn((t) => ({ ...t, text: t.text + e.text }));
                break;

              case 'notice':
                patchLastBotTurn((t) => ({ ...t, notices: [...t.notices, e.text] }));
                break;

              case 'error':
                received.error = true;
                patchLastBotTurn((t) => ({ ...t, error: e.message, streaming: false }));
                break;

              case 'done':
                received.done = true;
                setStats({
                  ms: e.totalMs,
                  inputTokens: e.usage?.inputTokens,
                  outputTokens: e.usage?.outputTokens,
                  books: e.bookCount,
                });
                // logRef 는 이 답변에 평가를 붙일 위치입니다.
                // 백엔드가 기록 저장에 실패하면 null 이 오고, 그 경우
                // ChatWindow 가 평가 버튼을 아예 표시하지 않습니다.
                patchLastBotTurn((t) => ({
                  ...t,
                  streaming: false,
                  usage: e.usage,
                  logRef: e.logRef ?? null,
                }));
                break;

              default:
                break;
            }
          },
        });
        // ── 스트림이 정상 종료됐지만 실제 답변이 없는 경우 ──────────
        // 이걸 처리하지 않으면 화면에 아무것도 표시되지 않아
        // 사용자는 "커서만 깜빡이다 멈췄다"고 느끼고 원인을 알 수 없습니다.
        if (!received.error && received.deltas === 0) {
          const elapsed = formatDecimal((Date.now() - t0) / 1000, lang);
          const diag = [
            t('diag.events', { count: received.events }),
            received.firstByteMs !== null
              ? t('diag.firstByte', { ms: received.firstByteMs })
              : t('diag.noResponse'),
            t('diag.total', { seconds: elapsed }),
            received.done ? t('diag.doneYes') : t('diag.doneNo'),
          ].join(' · ');

          patchLastBotTurn((turn) => ({
            ...turn,
            streaming: false,
            error: received.events === 0 ? t('diag.nothing', { diag }) : t('diag.noText', { diag }),
          }));
        }
      } catch (err) {
        const isTimeout = err.message === 'client-timeout' || err.cause?.message === 'client-timeout';
        if (isTimeout) {
          patchLastBotTurn((turn) => ({
            ...turn,
            streaming: false,
            error: t('diag.timeout'),
          }));
        } else if (err.name === 'AbortError') {
          patchLastBotTurn((turn) => ({
            ...turn,
            streaming: false,
            notices: [...turn.notices, t('diag.aborted')],
          }));
        } else {
          setError(err.message || t('err.unknown'));
          patchLastBotTurn((turn) => ({ ...turn, streaming: false }));
        }
      } finally {
        clearTimeout(timeoutId);
        setBusy(false);
        abortRef.current = null;
        patchLastBotTurn((turn) => ({ ...turn, streaming: false }));
      }
    },
    [busy, patchLastBotTurn, t, lang],
  );

  const handleAbort = () => abortRef.current?.abort();

  const handleReset = () => {
    // 새 대화를 시작하면 목록 화면도 닫습니다.
    // 저장한 책은 지우지 않습니다 — 대화와 별개로 남아야 하는 데이터입니다.
    setShowSaved(false);
    abortRef.current?.abort();
    clearSession();
    setTurns([]);
    setError('');
    setStats(null);
    setInput('');
  };

  const streaming = turns.some((t) => t.streaming);

  return (
    <div className="app">
      <header className="header">
        <div className="header__brand">
          {/* 인쇄공의 표식. 이모지를 쓰지 않고 CSS로 괘선과 마름모를 그립니다
              (이모지는 기기마다 모양이 다르고 편집 디자인과 어울리지 않습니다). */}
          <span className="header__logo" aria-hidden="true" />
          <div>
            {/* 상표는 고유명사이므로 번역하지 않습니다.
                줄바꿈이 생기면 이름이 어색해져서 non-breaking space 로 묶었습니다. */}
            {/* CHOWOO 는 상표와 완전히 같은 조판입니다.
                서체·기울기·굵기·크기·색을 하나도 바꾸지 않습니다. */}
            <h1 className="header__title">
              Un&nbsp;Livre&nbsp;Pour&nbsp;Vous
              <span className="header__author">·&nbsp;CHOWOO</span>
            </h1>
            <p className="header__sub">{t('app.tagline')}</p>
          </div>
        </div>
        <div className="header__actions">
          {/* 읽을 목록 — 담은 책이 없으면 버튼을 숨겨 화면을 비워둡니다 */}
          {(savedBooks.length > 0 || showSaved) && (
            <button
              type="button"
              className={`header__saved${showSaved ? ' header__saved--on' : ''}`}
              onClick={() => setShowSaved((v) => !v)}
              aria-pressed={showSaved}
            >
              {t('saved.button', { count: savedBooks.length })}
            </button>
          )}

          {/* 언어 선택 — UI 언어만 바꿉니다. 챗봇 답변 언어는 입력한 언어를 따릅니다. */}
          <label className="header__lang">
            <span className="sr-only">{t('lang.label')}</span>
            <select
              className="header__lang-select"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              title={t('lang.label')}
            >
              {SUPPORTED_LANGS.map((code) => (
                <option key={code} value={code}>
                  {LANG_NAMES[code]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="header__theme"
            onClick={() => setTheme((cur) => (cur === 'light' ? 'dark' : 'light'))}
            aria-label={theme === 'light' ? t('theme.toDark') : t('theme.toLight')}
            title={theme === 'light' ? t('theme.dark') : t('theme.light')}
          >
            <span aria-hidden="true">{theme === 'light' ? '☾' : '☀'}</span>
          </button>
          {turns.length > 0 && (
            <button type="button" className="header__reset" onClick={handleReset}>
              {t('app.newChat')}
            </button>
          )}
        </div>
      </header>

      <main className="main">
        {showSaved ? (
          <SavedPanel onClose={() => setShowSaved(false)} />
        ) : turns.length === 0 ? (
          <div className="empty">
            {/* 장식 괘선 — CSS로 그립니다 */}
            <div className="empty__icon" aria-hidden="true" />
            <h2 className="empty__title">{t('empty.title')}</h2>
            <p className="empty__desc">
              {t('empty.desc1')}
              <br />
              {t('empty.desc2')}
            </p>
            <SuggestionChips suggestions={suggestions} onPick={send} disabled={busy} />
          </div>
        ) : (
          <ChatWindow turns={turns} streaming={streaming} error={error} />
        )}
      </main>

      {/* 읽을 목록을 보는 중에는 바닥글을 아예 내리지 않습니다.
          입력창만 숨기면 border-top 과 44px 짜리 빈 띠가 남아
          목록 아래에 근거 없는 괘선이 그려집니다.
          입력창을 숨기는 이유: 목록을 보면서 질문을 쓰면 답변이 어디에
          나타날지 알 수 없어 혼란스럽습니다. */}
      {!showSaved && (
        <footer className="footer">
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={() => send(input)}
            onAbort={handleAbort}
            busy={busy}
            maxChars={maxChars}
          />

          {/* 실습 프로젝트라 토큰/응답시간을 노출합니다.
              비용 감각을 익히는 데 도움이 됩니다. 실제 서비스라면 지우세요. */}
          {stats && !busy && (
            <p className="stats">
              {t('stats.line', {
                seconds: formatDecimal((stats.ms ?? 0) / 1000, lang),
                in: formatInt(stats.inputTokens ?? 0, lang),
                out: formatInt(stats.outputTokens ?? 0, lang),
              })}
              {stats.books ? t('stats.books', { count: formatInt(stats.books, lang) }) : ''}
            </p>
          )}
        </footer>
      )}
    </div>
  );
}
