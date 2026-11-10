import { useCallback, useEffect, useRef, useState } from "react";
import { startPolling } from "../../polling";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { messageOf } from "../api/errors.ts";
import type { KnowledgeDraftListDTO, PublishedKnowledgeDTO, ThreadSummaryDTO } from "../workflow-types.ts";

/**
 * 一覧ごとに独立して取得する。まだ取得できていない一覧は undefined。
 * `drafts` は未公開・未見送りの候補（確認できる版がないものも含む。表示側で絞る）。
 */
export type TeacherLists = {
  escalated?: ThreadSummaryDTO[];
  answered?: ThreadSummaryDTO[];
  /** AIが回答した会話（生徒が続きを質問して先生の手を離れたものを含む）。解決済みも含む */
  aiAnswered?: ThreadSummaryDTO[];
  drafts?: KnowledgeDraftListDTO[];
  dismissed?: KnowledgeDraftListDTO[];
  published?: PublishedKnowledgeDTO[];
};

type ListKey = keyof TeacherLists;

const allKeys: ListKey[] = ["escalated", "answered", "aiAnswered", "drafts", "dismissed", "published"];
// 定期的に取り直すのは、生徒やAIの動きで増える一覧だけ。ほかは先生の操作でしか変わらないため、
// 操作の後とタブを開いたときに取り直す（Firestore の読み取りを減らす）。
const pollKeys: ListKey[] = ["escalated", "drafts"];

/** 先生の返信が必要な相談か。返信を待たずに生徒が解決した相談は、escalated のままでも返信できない。 */
export function needsReply(thread: ThreadSummaryDTO) {
  return thread.status === "escalated" && thread.resolvedAt === null;
}

export function useTeacherLists(client: TeacherWorkflowClient) {
  const [lists, setLists] = useState<TeacherLists>({});
  const [errors, setErrors] = useState<Partial<Record<ListKey, string>>>({});
  const [loading, setLoading] = useState(false);
  // 一覧ごとの最新の要求番号。遅れて届いた古い応答で、新しい一覧を巻き戻さない。
  const latestRequest = useRef<Partial<Record<ListKey, number>>>({});
  const requestCount = useRef(0);
  const inFlight = useRef(0);

  const fetchList = useCallback((key: ListKey): Promise<TeacherLists[ListKey]> => {
    switch (key) {
      case "escalated": return client.listThreads("escalated");
      case "answered": return client.listThreads("teacher_answered");
      case "aiAnswered": return client.listThreads("ai_answered");
      case "drafts": return client.listDrafts();
      case "dismissed": return client.listDrafts("dismissed");
      case "published": return client.listPublished();
    }
  }, [client]);

  const load = useCallback(async (keys: ListKey[]) => {
    const request = ++requestCount.current;
    for (const key of keys) latestRequest.current[key] = request;
    inFlight.current++;
    setLoading(true);
    const results = await Promise.allSettled(keys.map(fetchList));
    inFlight.current--;
    if (inFlight.current === 0) setLoading(false);

    // 1つの一覧が失敗しても、取得できた一覧は反映する。失敗した一覧は前の内容を残す。
    const fresh = keys.filter((key) => latestRequest.current[key] === request);
    if (fresh.length === 0) return;
    setLists((current) => {
      const next = { ...current };
      keys.forEach((key, index) => {
        const result = results[index];
        if (fresh.includes(key) && result.status === "fulfilled") Object.assign(next, { [key]: result.value });
      });
      return next;
    });
    // 一部だけをポーリングしても、取得していない一覧の失敗は残す。
    setErrors((current) => {
      const next = { ...current };
      keys.forEach((key, index) => {
        if (!fresh.includes(key)) return;
        const result = results[index];
        if (result.status === "rejected") next[key] = messageOf(result.reason);
        else delete next[key];
      });
      return next;
    });
  }, [fetchList]);

  /** すべての一覧を取り直す。先生の操作の後とタブの切り替えで使う。 */
  const refresh = useCallback(() => load(allKeys), [load]);

  useEffect(() => {
    // 開発時の StrictMode で effect が2回走っても、初回の取得を1回にする。
    const firstLoad = setTimeout(() => void refresh());
    const stop = startPolling(async () => {
      // 前の取得が終わる前に次を始めると、遅い環境では応答が毎回捨てられて一覧が更新されない。
      if (inFlight.current === 0) await load(pollKeys);
    }, false);
    return () => {
      clearTimeout(firstLoad);
      stop();
    };
  }, [refresh, load]);

  const error = allKeys.map((key) => errors[key]).find(Boolean);
  return { lists, error, refresh, loading };
}
