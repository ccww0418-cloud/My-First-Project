import React from 'react';
import BookCard from './BookCard.jsx';
import { useI18n } from '../i18n.js';
import { useSavedBooks, clearAll, isPersistent, MAX_SAVED } from '../lib/savedBooks.js';

/**
 * 읽을 목록.
 *
 * 왜 모달(팝업)이 아닌가:
 *   모달로 만들면 포커스 트랩, 배경 스크롤 잠금, Esc 처리, 스크린리더용
 *   aria-modal 을 전부 직접 다뤄야 합니다. 하나라도 빠지면 키보드 사용자가
 *   갇히거나 배경이 같이 스크롤되는 버그가 생깁니다.
 *   대화 영역 자리에 그냥 바꿔 끼우면 그 복잡도가 전부 사라집니다.
 *   대화 상태(turns)는 App 에 그대로 남아 있어 닫으면 원래 대화로 돌아옵니다.
 */
export default function SavedPanel({ onClose }) {
  const { t } = useI18n();
  const books = useSavedBooks();

  return (
    <div className="saved">
      <div className="saved__head">
        <div>
          <h2 className="saved__title">{t('saved.title')}</h2>
          <p className="saved__count">
            {books.length > 0
              ? t('saved.count', { count: books.length, max: MAX_SAVED })
              : t('saved.emptyHint')}
          </p>
        </div>
        <div className="saved__actions">
          {books.length > 0 && (
            <button
              type="button"
              className="saved__btn"
              onClick={() => {
                // 되돌릴 수 없는 동작이라 한 번 묻습니다.
                if (window.confirm(t('saved.clearConfirm', { count: books.length }))) clearAll();
              }}
            >
              {t('saved.clear')}
            </button>
          )}
          <button type="button" className="saved__btn saved__btn--close" onClick={onClose}>
            {t('saved.close')}
          </button>
        </div>
      </div>

      {/* 시크릿 모드 등에서 localStorage 가 막히면 저장이 유지되지 않습니다.
          조용히 실패하면 사용자가 "담았는데 사라졌다"고 느끼므로 미리 알립니다. */}
      {!isPersistent() && <p className="saved__warn">{t('saved.notPersistent')}</p>}

      {books.length === 0 ? (
        <div className="saved__empty">
          <div className="empty__icon" aria-hidden="true" />
          <p className="saved__empty-text">{t('saved.emptyBody')}</p>
        </div>
      ) : (
        <section className="cards" aria-label={t('saved.listAria', { count: books.length })}>
          {books.map((b) => (
            // inList 로 넘기면 카드가 '저장하기' 대신 '빼기' 를 보여줍니다.
            <BookCard key={b.key} book={b} inList />
          ))}
        </section>
      )}
    </div>
  );
}
