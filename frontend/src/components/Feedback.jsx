import React, { useState } from 'react';
import { useI18n } from '../i18n.js';
import { sendFeedback } from '../api.js';

/**
 * 답변 평가 (좋았어요 / 아니에요)
 *
 * 왜 이 기능이 필요한가:
 *   지금까지 추천이 좋았는지 알 방법이 전혀 없었습니다.
 *   호출 횟수만 보였고, 어떤 질문에서 실패하는지·프롬프트를 바꿨을 때
 *   나아졌는지 판단할 근거가 없었습니다. 측정 없이는 개선이 불가능합니다.
 *
 * 왜 별도 컴포넌트인가:
 *   보낸 상태를 자기 안에 들고 있으면 이 부분만 다시 렌더됩니다.
 *   App 에 상태를 두면 평가 한 번에 대화 전체가 재렌더됩니다.
 *
 * 설계 판단:
 *   · 성공하면 버튼을 감사 문구로 바꿉니다. 조용히 무시하면
 *     "눌렸나?" 하고 다시 누르게 되기 때문입니다.
 *   · ★ 실패하면 버튼을 남겨서 다시 누를 수 있게 합니다.
 *     전에는 sent 를 'failed' 로 두고 `if (busy || sent) return` 로 막았는데,
 *     'failed' 도 truthy 라서 한 번 실패하면 영구히 잠겼습니다.
 *     사용자는 실패 문구만 보고 아무것도 할 수 없었습니다.
 *   · 실패해도 대화에 지장이 없습니다.
 *   · logRef 가 없으면(기록 저장 실패) 아무것도 표시하지 않습니다.
 *     누를 수 없는 버튼을 보여주는 것보다 낫습니다.
 *
 * @param {{logRef: string|null}} p
 */
export default function Feedback({ logRef }) {
  const { t } = useI18n();
  /** null=아직 / 'up' / 'down' = 전송 성공 */
  const [sent, setSent] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!logRef) return null;

  const submit = async (verdict) => {
    // 성공한 뒤에만 잠급니다. 실패는 재시도 가능해야 합니다.
    if (busy || sent) return;
    setBusy(true);
    setFailed(false);
    const ok = await sendFeedback({ logRef, verdict });
    if (ok) setSent(verdict);
    else setFailed(true);
    setBusy(false);
  };

  if (sent) {
    // role="status" 로 두면 스크린리더가 결과를 알려줍니다.
    return (
      <p className="fb">
        <span className="fb__done" role="status">
          {sent === 'up' ? t('fb.thanksUp') : t('fb.thanksDown')}
        </span>
      </p>
    );
  }

  return (
    <div className="fb">
      <span className="fb__ask">{failed ? t('fb.failedRetry') : t('fb.ask')}</span>
      <button type="button" className="fb__btn" onClick={() => submit('up')} disabled={busy}>
        {t('fb.up')}
      </button>
      <button type="button" className="fb__btn" onClick={() => submit('down')} disabled={busy}>
        {t('fb.down')}
      </button>
      {/* 실패 사실은 aria-live 로 알립니다 — 버튼은 그대로 남아 재시도 가능 */}
      {failed && (
        <span className="fb__failed" role="status">
          {t('fb.failed')}
        </span>
      )}
    </div>
  );
}
