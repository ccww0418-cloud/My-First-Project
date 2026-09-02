import React, { useEffect, useRef } from 'react';
import { useI18n, formatInt } from '../i18n.js';

/**
 * 상한 폴백.
 *
 * 정상 경로에서는 /api/config 의 maxMessageChars 를 씁니다. 이 값은
 * 백엔드가 실제로 검증에 쓰는 값이라 어긋날 수 없습니다.
 * 여기 상수는 config 요청이 실패했을 때만 쓰이는 안전망입니다.
 * (전에는 이 상수만 있어서 백엔드가 상한을 바꾸면 조용히 틀어졌습니다)
 */
const FALLBACK_MAX_CHARS = 2000;

/**
 * 입력창.
 *
 * 접근성 고려사항:
 *  - textarea에 label 연결 (aria-label)
 *  - Enter 전송 / Shift+Enter 줄바꿈 (IME 조합 중에는 전송하지 않음 ★)
 *  - 남은 글자 수를 aria-live로 알림
 *  - 전송 중에는 버튼이 "중단"으로 바뀌어 취소 가능
 */
export default function Composer({ value, onChange, onSubmit, onAbort, busy, maxChars }) {
  const { t, lang } = useI18n();
  const ref = useRef(null);
  // 백엔드가 알려준 값이 있으면 그것을 씁니다.
  const MAX_CHARS = Number(maxChars) > 0 ? Number(maxChars) : FALLBACK_MAX_CHARS;

  // 입력 내용에 따라 높이 자동 조절
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  // 전송이 끝나면 다시 입력창에 포커스
  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  const handleKeyDown = (e) => {
    // ★ 한글 입력의 핵심: IME 조합 중(isComposing)에 Enter를 누르면
    //   그것은 "글자 확정"이지 "전송"이 아닙니다.
    //   이 검사를 빼면 한글 입력 중 Enter를 누를 때마다 메시지가 전송됩니다.
    if (e.nativeEvent.isComposing) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy) onSubmit();
    }
  };

  const remaining = MAX_CHARS - value.length;
  const nearLimit = remaining < 200;

  return (
    <form
      id="composer"
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <div className="composer__box">
        <textarea
          ref={ref}
          className="composer__input"
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, MAX_CHARS))}
          onKeyDown={handleKeyDown}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.aria')}
          rows={1}
          maxLength={MAX_CHARS}
          disabled={busy}
        />

        {busy ? (
          <button type="button" className="composer__btn composer__btn--stop" onClick={onAbort}>
            {t('composer.stop')}
          </button>
        ) : (
          <button type="submit" className="composer__btn" disabled={!value.trim()}>
            {t('composer.send')}
            <span className="sr-only">{t('composer.sendHint')}</span>
          </button>
        )}
      </div>

      <div className="composer__foot">
        <span className="composer__hint">{t('composer.hint')}</span>
        {nearLimit && (
          <span className={`composer__count${remaining < 50 ? ' composer__count--warn' : ''}`} aria-live="polite">
            {t('composer.remaining', { count: formatInt(remaining, lang) })}
          </span>
        )}
      </div>
    </form>
  );
}
