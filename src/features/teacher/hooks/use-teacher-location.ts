import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { parseTeacherLocation, type TeacherLocation, teacherLocationSearch, type TeacherView } from "../teacher-location.ts";

/** 一覧から開いたダイアログの履歴に付ける印。閉じるときに、一つ前の履歴が元の一覧だと分かる。 */
const OPENED_FROM_LIST = "openedFromList";

type HeldLocation = { href: string; search: string; openedFromList: boolean; onBlocked: () => void };

/** 入力中・送信中のダイアログが開いている間、画面の表示を止めておく URL。 */
let held: HeldLocation | undefined;
/** 画面の操作（×・共有の完了など）でダイアログを閉じている途中か。ブラウザの「戻る」と区別する。 */
let closingDialog = false;

/**
 * `active` の間は、ブラウザの「戻る」「進む」で画面を移動させず、URL を元に戻して `onBlocked` を呼ぶ。
 * popstate は Next.js のルーターが先に処理するため、イベントを止めるのではなく、表示を止めてから URL を戻す。
 */
export function useHoldLocation(active: boolean, onBlocked: () => void) {
  const latestOnBlocked = useRef(onBlocked);
  useEffect(() => {
    latestOnBlocked.current = onBlocked;
  }, [onBlocked]);

  // URL は active になった時点で一度だけ記録する。送信の完了などで記録し直すと、戻るで変わった後の URL を掴むことがある。
  useEffect(() => {
    if (!active) return;
    const current: HeldLocation = {
      href: window.location.href,
      search: teacherLocationSearch(parseTeacherLocation(new URLSearchParams(window.location.search))),
      openedFromList: Boolean(window.history.state?.[OPENED_FROM_LIST]),
      onBlocked: () => latestOnBlocked.current(),
    };
    held = current;
    // 別のページへ戻る・再読み込み・タブを閉じる場合は popstate が来ないので、ブラウザの確認を出す。
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeLeaving);
      if (held === current) held = undefined;
    };
  }, [active]);
}

function push(next: TeacherLocation, state: Record<string, unknown> | null) {
  const search = teacherLocationSearch(next);
  // 同じ画面を押し直しても、ダブルクリックしても、同じ履歴を積まない。
  if (search !== window.location.search) window.history.pushState(state, "", `${window.location.pathname}${search}`);
}

/**
 * タブと開いている質問を URL で管理する。
 * `router.push` はサーバーのページを取り直すため（認証と Firestore の読み取りが増える）、`window.history` を使う。
 */
export function useTeacherLocation() {
  const searchParams = useSearchParams();
  const urlSearch = teacherLocationSearch(parseTeacherLocation(searchParams));
  const shownSearch = (closingDialog ? undefined : held?.search) ?? urlSearch;
  const location = useMemo(() => parseTeacherLocation(new URLSearchParams(shownSearch)), [shownSearch]);
  const { view, question, dismissed } = location;

  useEffect(() => {
    if (closingDialog) {
      closingDialog = false;
      return;
    }
    if (!held || urlSearch === held.search) return;
    // Next.js のルーターにも元の URL を伝えるため、内部の履歴情報は渡さない。
    window.history.pushState(held.openedFromList ? { [OPENED_FROM_LIST]: true } : null, "", held.href);
    held.onBlocked();
  }, [urlSearch]);

  const showView = useCallback((next: TeacherView) => push({ view: next }, null), []);

  const openItem = useCallback((item: Pick<TeacherLocation, "question" | "dismissed">, targetView: TeacherView = view) => {
    push({ view: targetView, ...item }, { [OPENED_FROM_LIST]: true });
  }, [view]);

  const closeItem = useCallback(() => {
    if (closingDialog || (!question && !dismissed)) return;
    closingDialog = true;
    if (window.history.state?.[OPENED_FROM_LIST]) {
      // 閉じた後に「戻る」で同じダイアログが開き直さないよう、開いた履歴ごと戻る。
      window.history.back();
    } else {
      // URL を直接開いたときは、一つ前の履歴がこのアプリとは限らないので置き換える。
      window.history.replaceState(null, "", `${window.location.pathname}${teacherLocationSearch({ view })}`);
    }
  }, [view, question, dismissed]);

  return { location, showView, openItem, closeItem };
}
