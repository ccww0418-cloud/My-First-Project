/**
 * 읽을 목록 (책 저장)
 *
 * 왜 이 기능이 필요한가:
 *   전에는 추천받은 책을 보관할 방법이 아예 없었습니다.
 *   세션 ID를 sessionStorage 에 뒀기 때문에 **탭을 닫으면 대화가 사라집니다.**
 *   좋은 책 세 권을 받고 탭을 닫으면 제목도 기억 못 하고 다시 찾을 수도 없었습니다.
 *   서비스의 핵심 가치가 "나에게 맞는 책 찾기"인데 찾은 결과가 증발했습니다.
 *
 * 왜 백엔드를 쓰지 않는가:
 *   로그인이 없습니다. 로그인을 붙이면 사용자가 떠납니다.
 *   localStorage 만으로 "같은 브라우저에서는 계속 남는다"가 되고, 그게 충분합니다.
 *   기기 간 동기화가 필요해지면 그때 계정을 붙이면 됩니다.
 *
 * 왜 useState 가 아니라 useSyncExternalStore 인가:
 *   여러 컴포넌트(책 카드 여러 개 + 헤더 개수 + 목록 화면)가 같은 데이터를 봅니다.
 *   각자 useState 로 들면 서로 어긋납니다. Context 를 쓰면 트리를 감싸야 합니다.
 *   i18n.js 와 같은 방식으로 모듈 밖에 하나만 두고 구독합니다.
 *
 * ⚠️ 저장 형태를 축소하는 이유:
 *   도구가 반환하는 레코드는 설명·전체 카테고리·무드가 붙어 권당 8KB 쯤 됩니다.
 *   목록에 필요한 것만 남기면 1KB 내외입니다.
 *   localStorage 는 도메인당 약 5MB 라, 축소하면 200권도 여유롭습니다.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'bookbot.saved';

/** 형태가 바뀌면 올립니다. 예전 데이터는 버리고 새로 시작합니다. */
const VERSION = 1;

/** 상한. 넘으면 새로 담는 것을 막습니다 (기존 것을 몰래 지우지 않습니다). */
export const MAX_SAVED = 200;

// ────────────────────────────────────────────────────────────────
// 저장 형태
// ────────────────────────────────────────────────────────────────

/**
 * 같은 책인지 판정하는 키.
 *
 * 백엔드 merge.mjs 와 같은 원칙입니다 — ISBN 이 있으면 그것으로, 없으면
 * 제목+저자를 정규화해서 비교합니다. 그래야 다른 검색에서 담은 같은 책이
 * 두 번 들어가지 않습니다.
 *
 * \p{L}\p{N} 를 쓰는 이유: [^a-z0-9] 로 하면 한글·일본어 제목이 빈 문자열이 됩니다.
 * (백엔드에서 실제로 이 버그가 있었습니다)
 */
export function bookKey(book) {
  const isbn = book?.isbn13?.[0];
  if (isbn) return `i:${isbn}`;

  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '');

  const t = norm(book?.title).slice(0, 40);
  const a = norm(book?.authors?.[0]).slice(0, 20);
  return t ? `t:${t}|${a}` : `x:${book?.id ?? ''}`;
}

/** 목록 표시에 필요한 필드만 남깁니다 (권당 8KB → 1KB) */
function shrink(book) {
  return {
    key: bookKey(book),
    id: book?.id ?? '',
    title: book?.title ?? '',
    subtitle: book?.subtitle ?? '',
    authors: (book?.authors ?? []).slice(0, 2),
    year: book?.year ?? null,
    pageCount: book?.pageCount ?? null,
    coverUrl: book?.coverUrl ?? null,
    isbn13: book?.isbn13?.[0] ? [book.isbn13[0]] : [],
    rating: book?.rating ?? null,
    links: book?.links ?? {},
    freeEbook: book?.freeEbook ?? null,
    sources: book?.sources ?? [],
    savedAt: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────
// 저장소 (localStorage + 메모리 폴백)
// ────────────────────────────────────────────────────────────────

/**
 * 시크릿 모드나 저장 공간 차단 상태에서는 localStorage 접근이 예외를 던집니다.
 * 그때는 메모리에만 들고 갑니다 — 새로고침하면 사라지지만 앱은 죽지 않습니다.
 */
let usable = true;

function read() {
  if (!usable) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // 형태가 다르면(버전 불일치·손상) 조용히 버립니다.
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter((b) => b && typeof b.key === 'string' && b.title);
  } catch {
    usable = false;
    return [];
  }
}

function write(items) {
  if (!usable) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, items }));
  } catch {
    // 용량 초과(QuotaExceededError) 등. 이후로는 메모리만 씁니다.
    usable = false;
  }
}

/** 현재 목록. localStorage 를 매번 읽지 않도록 메모리에 캐시합니다. */
let items = read();

const listeners = new Set();
function emit() {
  // 구독자에게 알리기 전에 참조를 새로 만들어야 React 가 변경을 감지합니다.
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** useSyncExternalStore 는 같은 참조를 돌려줘야 무한 렌더를 피합니다. */
function getSnapshot() {
  return items;
}

/** 서버 렌더링용 (이 앱은 CSR 이지만 훅 계약상 필요) */
const EMPTY = [];
function getServerSnapshot() {
  return EMPTY;
}

// ────────────────────────────────────────────────────────────────
// 조작
// ────────────────────────────────────────────────────────────────

/** @returns {{ok: true} | {ok: false, reason: 'full'}} */
export function saveBook(book) {
  const key = bookKey(book);
  if (items.some((b) => b.key === key)) return { ok: true }; // 이미 있음

  if (items.length >= MAX_SAVED) return { ok: false, reason: 'full' };

  // 최근에 담은 것이 위로 오게 앞에 넣습니다.
  items = [shrink(book), ...items];
  write(items);
  emit();
  return { ok: true };
}

export function removeBook(key) {
  const next = items.filter((b) => b.key !== key);
  if (next.length === items.length) return;
  items = next;
  write(items);
  emit();
}

export function toggleBook(book) {
  const key = bookKey(book);
  if (items.some((b) => b.key === key)) {
    removeBook(key);
    return { saved: false };
  }
  const r = saveBook(book);
  return { saved: r.ok, full: r.ok === false };
}

export function clearAll() {
  if (!items.length) return;
  items = [];
  write(items);
  emit();
}

export function isSaved(book) {
  const key = bookKey(book);
  return items.some((b) => b.key === key);
}

/** 저장이 실제로 유지되는 환경인지 (시크릿 모드 안내용) */
export function isPersistent() {
  return usable;
}

// ────────────────────────────────────────────────────────────────
// 훅
// ────────────────────────────────────────────────────────────────

/** 목록 전체를 구독합니다. 바뀌면 다시 렌더됩니다. */
export function useSavedBooks() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * 책 하나의 저장 여부만 구독합니다.
 *
 * 목록 전체를 구독하면 책을 담을 때마다 화면의 모든 카드가 다시 렌더됩니다.
 * 불리언 하나만 보면 해당 카드만 갱신됩니다.
 */
export function useIsSaved(book) {
  const key = bookKey(book);
  return useSyncExternalStore(
    subscribe,
    () => items.some((b) => b.key === key),
    () => false,
  );
}
