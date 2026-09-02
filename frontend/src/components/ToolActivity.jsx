import React from 'react';
import { useI18n, formatDecimal } from '../i18n.js';

/**
 * 도구 실행 진행 표시.
 *
 * 왜 이게 중요한가:
 *   도구를 호출하는 챗봇은 첫 글자가 나오기까지 5~15초가 걸립니다.
 *   그 동안 아무것도 안 보이면 사용자는 고장났다고 생각하고 이탈합니다.
 *   "지금 Google Books를 뒤지고 있고, 8권 찾았다"를 보여주면
 *   같은 대기 시간이 훨씬 짧게 느껴집니다.
 *
 * 백엔드의 tool_start / tool_end SSE 이벤트를 그대로 그립니다.
 */
export default function ToolActivity({ activities }) {
  const { t, lang } = useI18n();
  if (!activities?.length) return null;

  return (
    <ul className="tools" aria-label={t('tools.aria')}>
      {activities.map((a) => (
        <li key={a.id} className={`tools__item ${a.done ? 'tools__item--done' : 'tools__item--running'}`}>
          <span className="tools__icon" aria-hidden="true">
            {a.done ? '✓' : <span className="spinner" />}
          </span>
          <span className="tools__label">{a.label}</span>
          {a.query && <span className="tools__query">“{a.query}”</span>}
          {a.done && (
            <span className="tools__result">
              {a.count > 0 ? t('tools.count', { count: a.count }) : t('tools.noResult')}
              {a.ms ? t('tools.seconds', { seconds: formatDecimal(a.ms / 1000, lang) }) : ''}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
