import React from 'react';
import { useI18n } from '../i18n.js';

/**
 * 예시 질문 칩.
 *
 * 목록은 백엔드 /api/config 에서 받아옵니다.
 * 프론트를 재배포(S3 업로드 + CloudFront 무효화)하지 않고
 * Lambda만 갱신해서 예시 문구를 바꿀 수 있습니다.
 */
export default function SuggestionChips({ suggestions, onPick, disabled }) {
  const { t } = useI18n();
  if (!suggestions?.length) return null;

  return (
    <div className="chips">
      <p className="chips__label" id="chips-label">
        {t('chips.label')}
      </p>
      <ul className="chips__list" aria-labelledby="chips-label">
        {/* key 는 인덱스를 씁니다. 제안 문구가 중복되면 key 가 충돌합니다
            (백엔드 목록이므로 중복이 들어갈 수 있습니다). */}
        {suggestions.map((s, i) => (
          <li key={i}>
            <button type="button" className="chip" onClick={() => onPick(s)} disabled={disabled}>
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
