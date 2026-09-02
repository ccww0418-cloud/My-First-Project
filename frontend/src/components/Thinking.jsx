import React, { useEffect, useState } from 'react';
import { useI18n, formatInt } from '../i18n.js';

/**
 * 답변을 기다리는 동안 보여주는 표시.
 *
 * 왜 필요한가:
 *   지금 백엔드는 버퍼 응답입니다(API Gateway HTTP API 가 응답 스트리밍을
 *   지원하지 않아서 — 자세한 이유는 docs/01-architecture.md 3.2 절).
 *   그래서 tool_start / tool_end 이벤트가 **마지막에 한꺼번에** 도착하고,
 *   기다리는 동안에는 진행 표시가 아무 역할을 못 합니다.
 *   전에는 스피너 하나와 "연결 중" 한 줄이 10~25초 동안 그대로 있었습니다.
 *   사용자는 멈춘 것과 구분할 수 없습니다.
 *
 * ★ 설계 원칙 — 모르는 것을 아는 척하지 않습니다.
 *   진행 이벤트가 없으니 "Google Books 검색 중" 같은 건 표시할 수 없습니다.
 *   그건 거짓입니다. 대신 **확실한 것만** 씁니다.
 *     1) 경과 시간 — 실측값입니다.
 *     2) 단계 문구 — 서버의 예산 배분에서 그 시점에 실제로 일어나는 일입니다.
 *        도구 라운드가 먼저(최대 11초), 그다음이 답변 생성(약 13~15초)입니다.
 *        (backend config: AGENT_BUDGET_MS / ANSWER_RESERVE_MS / REQUEST_BUDGET_MS)
 *
 * ★ 왜 별도 컴포넌트인가:
 *   초 카운터가 1초마다 상태를 바꿉니다. 이걸 App 에 두면 그때마다 대화 전체가
 *   다시 렌더됩니다. 자기 안에 두면 이 한 줄만 다시 그립니다.
 */

/**
 * 단계 문구. `after` 는 경과 초.
 *
 * 서버 예산과 맞춰둔 값이라 추측이 아닙니다. 백엔드에서 예산을 바꾸면
 * 여기도 같이 조정하세요 — 어긋나면 "답변 작성 중" 이 뜬 뒤에도
 * 검색이 돌고 있는 상태가 됩니다.
 */
export const STAGES = [
  { after: 0, key: 'wait.preparing' },
  { after: 2, key: 'wait.searching' },
  { after: 12, key: 'wait.writing' },
  { after: 22, key: 'wait.almost' },
];

/**
 * 경과 초에 해당하는 단계를 돌려줍니다.
 *
 * 함수로 뽑아 내보내는 이유: SSR 렌더 검수는 0초 상태만 볼 수 있습니다
 * (useEffect 가 돌지 않으므로). 단계 전환이 서버 예산과 맞는지는
 * 이 함수를 직접 확인해야 검증됩니다.
 */
export function stageAt(seconds) {
  let stage = STAGES[0];
  for (const s of STAGES) {
    if (seconds >= s.after) stage = s;
  }
  return stage;
}

export default function Thinking() {
  const { t, lang } = useI18n();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    // Date.now() 기준으로 셉니다. setInterval 은 지연이 누적되므로
    // 카운터를 직접 증가시키면 실제 경과 시간과 어긋납니다.
    const startedAt = Date.now();
    const id = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const stage = stageAt(seconds);

  return (
    <p className="thinking">
      <span className="spinner" aria-hidden="true" />

      {/* role="status" 를 단계 문구에만 둡니다.
          초 카운터까지 읽어주면 스크린리더가 1초마다 숫자를 말해 방해가 됩니다.
          단계는 요청 한 번에 3~4번만 바뀌므로 알림으로 적당합니다. */}
      <span role="status">{t(stage.key)}</span>

      {/* 경과 시간은 3초 뒤부터 보여줍니다. 빠르게 끝나는 요청에
          숫자가 깜빡이고 사라지면 오히려 산만합니다. */}
      {seconds >= 3 && (
        <span className="thinking__elapsed" aria-hidden="true">
          {t('wait.elapsed', { seconds: formatInt(seconds, lang) })}
        </span>
      )}
    </p>
  );
}
