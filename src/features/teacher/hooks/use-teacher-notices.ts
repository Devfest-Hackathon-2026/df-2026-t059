import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { needsReply, type TeacherLists } from "./use-teacher-lists.ts";

export type TeacherNotice = { key: string; kind: "thread" | "draft"; id: string; label: string; title: string };

/** 先生の操作の結果が一覧に届くまで待つ時間。一覧の定期取得（10秒）より長くする。 */
const OWN_ACTION_GRACE_MS = 30_000;

const storageKey = (courseId: string) => `teacher-notices-seen:${courseId}`;

function readSeen(courseId: string): Set<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(courseId)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSeen(courseId: string, seen: Set<string>) {
  try {
    window.localStorage.setItem(storageKey(courseId), JSON.stringify([...seen]));
  } catch {
    // 保存できないブラウザでは、次に開いたときにまた新着として出るだけなので無視する。
  }
}

/**
 * 先生への通知（返信待ちの相談・確認待ちの共有候補）。一覧の定期取得の結果から作るので、サーバーへの追加の読み取りはない。
 * 既読はこのブラウザにだけ記録する。同じ相談でも更新されたら、同じ候補でも新しい案が増えたら、もう一度新着にする。
 * ただし先生自身の操作で起きた変化（編集の保存・候補の作成・公開の取り下げ・見送りからの復帰）は新着にしない。
 *
 * @param openId いま開いている質問・候補の ID。開いたものは既読にし、開いている間の変化も新着にしない
 */
export function useTeacherNotices(courseId: string, lists: TeacherLists, openId: string | undefined) {
  const [seen, setSeen] = useState(() => readSeen(courseId));
  // 質問 ID ごとの「この時刻までに届いた変化は先生自身の操作」という期限。
  const ownActionUntil = useRef(new Map<string, number>());

  const notices = useMemo<TeacherNotice[]>(() => [
    ...(lists.escalated ?? []).filter(needsReply)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((thread): TeacherNotice => ({
        key: `thread:${thread.id}:${thread.updatedAt}`,
        kind: "thread",
        id: thread.id,
        label: "先生への相談が届いています",
        title: thread.title,
      })),
    ...(lists.drafts ?? []).flatMap((draft): TeacherNotice[] => (draft.question === null ? [] : [{
      key: `draft:${draft.questionId}:${draft.versionCount}`,
      kind: "draft",
      id: draft.questionId,
      label: "共有候補が確認を待っています",
      title: draft.question,
    }])),
  ], [lists.escalated, lists.drafts]);

  const loaded = lists.escalated !== undefined && lists.drafts !== undefined;
  const unread = useMemo(() => notices.filter((notice) => !seen.has(notice.key)), [notices, seen]);

  const save = useCallback((next: Set<string>) => {
    setSeen(next);
    writeSeen(courseId, next);
  }, [courseId]);

  /** 先生自身の操作があった質問。このあと一覧に届く変化を新着にしない。 */
  const acknowledge = useCallback((id: string) => {
    ownActionUntil.current.set(id, Date.now() + OWN_ACTION_GRACE_MS);
  }, []);

  // 閉じた直後の一覧の取り直しも、開いている間の操作の結果として扱う。
  useEffect(() => {
    if (!openId) return;
    return () => acknowledge(openId);
  }, [openId, acknowledge]);

  useEffect(() => {
    if (openId) acknowledge(openId);
    const now = Date.now();
    const own = unread.filter((notice) => (ownActionUntil.current.get(notice.id) ?? 0) > now);
    if (own.length > 0) save(new Set([...seen, ...own.map((notice) => notice.key)]));
  }, [unread, seen, openId, acknowledge, save]);

  /** ベルを開いたとき、一覧にあるものをすべて既読にする。 */
  const markAllSeen = useCallback(() => {
    // 一覧から消えたものの記録は捨てる。読み込み前は何も分からないので消さない。
    save(new Set([...(loaded ? [] : seen), ...notices.map((notice) => notice.key)]));
  }, [loaded, seen, notices, save]);

  return { notices, unread, loaded, markAllSeen, acknowledge };
}
