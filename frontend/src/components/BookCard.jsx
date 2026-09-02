import React, { useState } from 'react';
import { useI18n, formatCompact, formatDecimal, formatInt } from '../i18n.js';
import { useIsSaved, toggleBook, removeBook, bookKey, MAX_SAVED } from '../lib/savedBooks.js';

/**
 * 책 카드.
 *
 * 이 컴포넌트가 받는 데이터는 LLM이 만든 게 아니라
 * 백엔드가 4개 도서 API에서 가져와 병합한 원본 레코드입니다.
 * (SSE의 { type:'books', items:[...] } 이벤트)
 *
 * → 표지, 평점, 무드, 다운로드 링크가 전부 실제 데이터라 환각이 없습니다.
 *   동시에 이 데이터를 LLM에 넣지 않으므로 토큰도 절약됩니다.
 */
/**
 * @param {object} p
 * @param {object} p.book
 * @param {boolean} [p.inList]  읽을 목록 화면에서 쓰는 중인지.
 *   true 면 저장 토글 대신 '빼기' 버튼을 보여줍니다. 목록에 있는 책에
 *   "저장하기"가 떠 있으면 혼란스럽기 때문입니다.
 */
export default function BookCard({ book, inList = false }) {
  const { t, lang } = useI18n();
  const [imgFailed, setImgFailed] = useState(false);
  // 목록 전체가 아니라 이 책의 저장 여부만 구독합니다.
  // 전체를 구독하면 책 하나를 담을 때 화면의 모든 카드가 다시 렌더됩니다.
  const saved = useIsSaved(book);
  const [full, setFull] = useState(false);

  const onToggle = () => {
    const r = toggleBook(book);
    // 상한(200권)에 걸린 경우에만 안내를 띄웁니다.
    setFull(r.saved === false && r.full === true);
  };

  const {
    title,
    subtitle,
    authors = [],
    year,
    pageCount,
    coverUrl,
    rating,
    moods = [],
    genres = [],
    categories = [],
    contentWarnings = [],
    series,
    seriesPosition,
    hasAudiobook,
    freeEbook,
    links = {},
    sources = [],
  } = book;

  const tags = (genres.length ? genres : categories).slice(0, 3);
  const authorLine =
    authors.slice(0, 2).join(', ') +
    (authors.length > 2 ? t('card.andOthers', { count: authors.length - 2 }) : '');

  const freeLinks = freeEbook?.links ?? {};
  const externalLinks = [
    // 알라딘을 앞에 둡니다 — 국내 도서는 여기서 바로 살 수 있어 가장 유용합니다.
    // 라벨을 t() 로 뽑습니다. 나머지는 라틴 문자 상표라 그대로 두면 되지만
    // 이 둘은 한글이라, 영어 화면에서 하드코딩하면 읽을 수 없습니다.
    { label: t('card.srcAladin'), href: links.aladin },
    // 국립중앙도서관 — 국내서 서지 기준점. 절판·구간도 여기서 확인됩니다.
    // 링크를 보여주는 것 자체가 "이 책이 국내 서지에 실제로 있다"는 증거입니다.
    { label: t('card.srcNlk'), href: links.nlk },
    { label: 'Google Books', href: links.googleBooks },
    { label: 'Open Library', href: links.openLibrary },
    { label: 'Hardcover', href: links.hardcover },
    { label: 'Gutenberg', href: links.gutenberg },
  ].filter((l) => l.href);

  return (
    <article className="card" aria-label={`${title}, ${authorLine || t('card.unknownAuthor')}`}>
      <div className="card__cover">
        {coverUrl && !imgFailed ? (
          <img
            src={coverUrl}
            alt={t('card.coverAlt', { title })}
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
          />
        ) : (
          // 표지가 없거나 로딩 실패 시 제목 이니셜로 대체
          <div className="card__cover-fallback" aria-hidden="true">
            {title?.slice(0, 2) || '—'}
          </div>
        )}
      </div>

      <div className="card__info">
        <h4 className="card__title">
          {title}
          {subtitle && <span className="card__subtitle">{subtitle}</span>}
        </h4>

        <p className="card__meta">
          {authorLine || t('card.noAuthor')}
          {year && <> · {year}</>}
          {pageCount ? <> · {t('card.pages', { count: formatInt(pageCount, lang) })}</> : null}
        </p>

        {series && (
          <p className="card__series">
            {t('card.series', { series })}
            {seriesPosition ? t('card.seriesPos', { position: seriesPosition }) : ''}
          </p>
        )}

        <div className="card__badges">
          {rating && (
            <span className="badge badge--rating" title={t('card.ratingTitle', { source: rating.source })}>
              ★ {formatDecimal(rating.value, lang)}
              <span className="badge__sub">
                {rating.count > 0
                  ? ` (${t('card.ratings', { count: formatCompact(rating.count, lang) })})`
                  : ''}
              </span>
            </span>
          )}
          {freeEbook && <span className="badge badge--free">{t('card.free')}</span>}
          {hasAudiobook && <span className="badge badge--audio">{t('card.audiobook')}</span>}
          {sources.length > 1 && (
            <span className="badge badge--verified" title={t('card.verifiedTitle', { sources: sources.join(', ') })}>
              {t('card.verified', { count: sources.length })}
            </span>
          )}
        </div>

        {/* 콜백 인자를 tag 로 둡니다. 전에는 t 였는데 그러면 번역 함수 t 를
            가려버려서, 이 안에서 t('...') 를 쓰는 순간 깨집니다.
            key 도 장르명이 중복될 수 있어 인덱스를 씁니다. */}
        {tags.length > 0 && (
          <ul className="card__tags" aria-label={t('card.genres')}>
            {tags.map((tag, i) => (
              <li key={i}>{tag}</li>
            ))}
          </ul>
        )}

        {moods.length > 0 && (
          <p className="card__moods">
            <span className="card__moods-label">{t('card.moods')}</span>
            {moods.slice(0, 4).join(' · ')}
          </p>
        )}

        {contentWarnings.length > 0 && (
          <details className="card__warning">
            <summary>{t('card.warnings', { count: contentWarnings.length })}</summary>
            <p>{contentWarnings.join(', ')}</p>
          </details>
        )}

        {/* 무료 전자책 다운로드 — 이 프로젝트에서 체감 만족도가 가장 높은 부분 */}
        {freeEbook && (
          <div className="card__free">
            <span className="card__free-label">{t('card.freeAt', { source: freeEbook.source })}</span>
            <div className="card__free-links">
              {freeLinks.epub && <ExtLink href={freeLinks.epub} kind="primary">EPUB</ExtLink>}
              {freeLinks.txt && <ExtLink href={freeLinks.txt} kind="primary">TXT</ExtLink>}
              {freeLinks.html && <ExtLink href={freeLinks.html} kind="primary">{t('card.readWeb')}</ExtLink>}
              {freeLinks.read && !freeLinks.html && !freeLinks.epub && (
                <ExtLink href={freeLinks.read} kind="primary">{t('card.read')}</ExtLink>
              )}
            </div>
          </div>
        )}

        {externalLinks.length > 0 && (
          <div className="card__links">
            {externalLinks.map((l) => (
              <ExtLink key={l.label} href={l.href}>
                {l.label}
              </ExtLink>
            ))}
          </div>
        )}

        {/* 저장 — 이 서비스에서 가장 중요한 동작입니다.
            전에는 추천받은 책을 보관할 방법이 없어서 탭을 닫으면 다 사라졌습니다. */}
        <div className="card__actions">
          {inList ? (
            <button
              type="button"
              className="card__save card__save--remove"
              onClick={() => removeBook(bookKey(book))}
            >
              {t('saved.remove')}
            </button>
          ) : (
            <button
              type="button"
              className={`card__save${saved ? ' card__save--on' : ''}`}
              onClick={onToggle}
              aria-pressed={saved}
            >
              {saved ? t('saved.saved') : t('saved.save')}
            </button>
          )}
          {full && <span className="card__save-warn">{t('saved.full', { max: MAX_SAVED })}</span>}
        </div>
      </div>
    </article>
  );
}

/**
 * 외부 링크.
 * rel="noopener noreferrer"는 필수입니다 — 없으면 열린 페이지가
 * window.opener로 우리 페이지를 조작할 수 있습니다(탭재킹).
 */
function ExtLink({ href, children, kind }) {
  const { t } = useI18n();
  return (
    <a
      className={`extlink${kind === 'primary' ? ' extlink--primary' : ''}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <span className="sr-only">{t('card.newWindow')}</span>
    </a>
  );
}
