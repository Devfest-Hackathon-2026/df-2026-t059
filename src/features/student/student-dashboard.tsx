"use client";

import { useSearchParams } from "next/navigation";
import { type ReactNode, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CourseViewDTO, PublishedKnowledgeDTO, StudentNotificationDTO, StudentThreadDetailDTO, ThreadSummaryDTO } from "../../domain/course-workflow.ts";
import { LoadingStatus, Spinner } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import { startPolling } from "../polling";
import { createStudentClient, StudentApiError } from "./api";
import { parseStudentLocation, type StudentLocation, studentLocationSearch } from "./student-location";
import { emptyQuestionFilters, SharedQuestions, StudentChat, type StudentChatAction, StudentHistory, StudentMenu, StudentMobileMenu, type StudentTab } from "./student-view";
import { StudentNotifications } from "./student-notifications";
import { StudentKnowledgeDialog } from "./student-knowledge-dialog";
import { isFinished, needsHistoryDetail, type StudentThreadView } from "./student-view-model";

type StudentData = {
  threads?: ThreadSummaryDTO[];
  knowledge?: PublishedKnowledgeDTO[];
  details: Record<string, StudentThreadDetailDTO>;
  notifications?: StudentNotificationDTO[];
};

/** 既存A画面の表示モデルへ変換する。解決と先生回答済みの区別はDTOのまま保つ。 */
function toViewThread(thread: ThreadSummaryDTO, detail?: StudentThreadDetailDTO): StudentThreadView {
  const status = thread.resolvedAt ? "resolved" : thread.status === "teacher_answered" ? "answered"
    : thread.status === "escalated" ? "waiting" : thread.status === "pending" ? "pending" : "open";
  return { id: thread.id, title: thread.title, status, categoryIds: thread.categoryIds, messages: detail?.messages ?? [] };
}

function messageOf(error: unknown) {
  return error instanceof StudentApiError ? error.message : "読み込みに失敗しました。もう一度お試しください。";
}

/** 非同期処理の完了時など、描画の外から今の画面を確かめる。 */
function currentSearch() {
  return studentLocationSearch(parseStudentLocation(new URLSearchParams(window.location.search)));
}

function urlOf(search: string) {
  return `${window.location.pathname}${search}`;
}

export function StudentDashboard({ course, headerActions }: { course: CourseViewDTO; headerActions?: ReactNode }) {
  const client = useMemo(() => createStudentClient(course.id), [course.id]);
  const searchParams = useSearchParams();
  const location = useMemo(() => parseStudentLocation(searchParams), [searchParams]);
  const locationSearch = studentLocationSearch(location);
  const [data, setData] = useState<StudentData>({ details: {} });
  const [filters, setFilters] = useState(emptyQuestionFilters);
  const [listError, setListError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [sourceError, setSourceError] = useState<string>();
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [operationError, setOperationError] = useState<string>();
  const [operationSuccess, setOperationSuccess] = useState<string>();
  const [notificationError, setNotificationError] = useState<string>();
  const [knowledgeId, setKnowledgeId] = useState<string>();
  const [operation, setOperation] = useState<"send" | StudentChatAction | "update">();
  const busy = operation !== undefined;
  const pendingAction = operation === "resolve" || operation === "escalate" ? operation : undefined;
  const [sending, setSending] = useState<{ text: string; previousCount: number }>();
  const [shownSearch, setShownSearch] = useState(locationSearch);
  const operationRunning = useRef(false);
  const navigation = useRef(0);
  const committedSearch = useRef(locationSearch);
  const detailRequest = useRef<{ id: string } | undefined>(undefined);
  const listRequest = useRef(0);
  const sourceRequest = useRef(0);
  const selectedId = location.tab === "thread" ? location.id : undefined;
  const detail = selectedId ? data.details[selectedId] : undefined;
  const relatedId = location.tab === "chat" ? location.sourceQuestionId : undefined;
  const sourceId = relatedId ?? detail?.relatedQuestion?.id;
  const source = sourceId ? data.details[sourceId] : undefined;
  const unread = data.notifications?.filter((notice) => notice.readAt === null).length ?? 0;

  function clearMessages() {
    setOperationError(undefined);
    setOperationSuccess(undefined);
    setDetailError(undefined);
    setSourceError(undefined);
    setHistoryError(undefined);
  }

  // 画面が変わったら（ブラウザの戻る・進むを含む）、前の画面のメッセージとダイアログを残さない。
  if (shownSearch !== locationSearch) {
    setShownSearch(locationSearch);
    clearMessages();
    setKnowledgeId(undefined);
    setSending(undefined);
  }

  // 画面を離れて同じ画面に戻った場合も「移動した」と分かるように数える。送信の完了で勝手に画面を移さないため。
  useEffect(() => {
    if (committedSearch.current === locationSearch) return;
    committedSearch.current = locationSearch;
    navigation.current++;
  }, [locationSearch]);

  /** 画面の移動。router.push はサーバーのページを取り直す（認証と Firestore の読み取りが増える）ため、window.history を使う。 */
  function navigate(next: StudentLocation) {
    clearMessages();
    const search = studentLocationSearch(next);
    if (search !== currentSearch()) window.history.pushState(null, "", urlOf(search));
  }

  const reloadLists = useCallback(async () => {
    const request = ++listRequest.current;
    setListLoading(true);
    const [threads, knowledge, notifications] = await Promise.allSettled([client.listThreads(), client.listKnowledge(), client.listNotifications()]);
    if (request !== listRequest.current) return;
    setData((current) => ({
      ...current,
      ...(threads.status === "fulfilled" ? { threads: threads.value } : {}),
      ...(knowledge.status === "fulfilled" ? { knowledge: knowledge.value } : {}),
      ...(notifications.status === "fulfilled" ? { notifications: notifications.value } : {}),
    }));
    const failure = [threads, knowledge].find((result) => result.status === "rejected");
    setListError(failure?.status === "rejected" ? messageOf(failure.reason) : undefined);
    setNotificationError(notifications.status === "rejected" ? messageOf(notifications.reason) : undefined);
    setListLoading(false);
  }, [client]);

  /** 読めない質問（URL が古い・他人の質問など）なら false を返す。ポーリングを止めるため。 */
  const reloadThread = useCallback(async () => {
    if (!selectedId) { setDetailLoading(false); return true; }
    const request = { id: selectedId };
    detailRequest.current = request;
    setDetailLoading(true);
    try {
      const thread = await client.readThread(selectedId);
      if (request === detailRequest.current) {
        setData((current) => ({ ...current, details: { ...current.details, [thread.id]: thread } }));
        setDetailError(undefined);
      }
    } catch (error) {
      if (request !== detailRequest.current) return true;
      setDetailError(messageOf(error));
      if (error instanceof StudentApiError && error.code === "NOT_FOUND") {
        setData((current) => {
          const details = { ...current.details };
          delete details[selectedId];
          return { ...current, details };
        });
        return false;
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
    return true;
  }, [client, selectedId]);

  // 一覧と開いている会話の更新だけを行う。ポーリングからAI処理は呼ばない。
  useEffect(() => {
    const stop = startPolling(reloadLists);
    return () => { listRequest.current++; stop(); };
  }, [reloadLists]);

  useEffect(() => {
    if (!selectedId) { setDetailLoading(false); return; }
    const stop = startPolling(reloadThread);
    return () => { detailRequest.current = undefined; stop(); };
  }, [reloadThread, selectedId]);

  const reloadSource = useCallback(async () => {
    if (!sourceId) return;
    const request = ++sourceRequest.current;
    setSourceError(undefined);
    try {
      const thread = await client.readThread(sourceId);
      if (request === sourceRequest.current) {
        setData((current) => ({ ...current, details: { ...current.details, [thread.id]: thread } }));
      }
    } catch (error) {
      if (request === sourceRequest.current) setSourceError(messageOf(error));
    }
  }, [client, sourceId]);

  const sourceLoaded = source !== undefined;
  useEffect(() => {
    if (!sourceId || sourceLoaded) return;
    const timer = setTimeout(() => void reloadSource());
    return () => { sourceRequest.current++; clearTimeout(timer); };
  }, [sourceId, sourceLoaded, reloadSource]);

  useEffect(() => {
    if (!unread) return;
    const original = document.title;
    const titled = `(${unread}) ${original}`;
    document.title = titled;
    return () => { if (document.title === titled) document.title = original; };
  }, [unread]);

  // 履歴の本文検索に必要な本人の詳細だけを読む。変更がない会話はキャッシュを使う。
  useEffect(() => {
    if (location.tab !== "history" || !data.threads) return;
    const missing = data.threads.filter((thread) => needsHistoryDetail(thread, data.details[thread.id]));
    if (!missing.length) { setHistoryLoading(false); return; }
    let active = true;
    setHistoryLoading(true);
    setHistoryError(undefined);
    void Promise.allSettled(missing.map(({ id }) => client.readThread(id))).then((results) => {
      if (!active) return;
      const loaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (loaded.length) setData((current) => ({
        ...current, details: { ...current.details, ...Object.fromEntries(loaded.map((thread) => [thread.id, thread])) },
      }));
      const failure = results.find((result) => result.status === "rejected");
      setHistoryError(failure?.status === "rejected" ? messageOf(failure.reason) : undefined);
      setHistoryLoading(false);
    });
    return () => { active = false; };
  }, [client, location.tab, data.threads, data.details]);

  async function mutate(run: () => Promise<StudentThreadDetailDTO>, options: { text?: string; successMessage?: string; action?: StudentChatAction } = {}) {
    const { text, successMessage, action } = options;
    if (operationRunning.current) return false;
    operationRunning.current = true;
    const startedSearch = currentSearch();
    const startedNavigation = navigation.current;
    const stayed = () => navigation.current === startedNavigation && currentSearch() === startedSearch;
    setOperation(action ?? (text !== undefined ? "send" : "update"));
    setOperationError(undefined);
    setOperationSuccess(undefined);
    if (text !== undefined) setSending({ text, previousCount: detail?.messages.length ?? 0 });
    try {
      const thread = await run();
      // 操作中に別の質問を開いた場合、その質問の読み込みは続ける。
      if (detailRequest.current?.id === thread.id) detailRequest.current = undefined;
      setData((current) => ({
        ...current, details: { ...current.details, [thread.id]: thread },
        threads: [thread, ...(current.threads ?? []).filter(({ id }) => id !== thread.id)],
      }));
      if (stayed()) {
        // 送信済みの入力画面は履歴に残さず、作成した質問に置き換える。戻るで空の入力画面を挟まない。
        const search = studentLocationSearch({ tab: "thread", id: thread.id });
        if (search !== startedSearch) window.history.replaceState(null, "", urlOf(search));
        if (successMessage && !thread.actions.canRetrySummary && thread.summaryStatus !== "generating") setOperationSuccess(successMessage);
      }
      return true;
    } catch (error) {
      if (stayed()) setOperationError(error instanceof StudentApiError && error.code === "NETWORK_ERROR" && !selectedId
        ? "通信が途切れました。相談中の質問に保存されていないか確認してから、再送してください。"
        : messageOf(error));
      return false;
    } finally {
      operationRunning.current = false;
      // URL の更新は Next.js の transition で反映される。同じ描画で消して、空の入力画面を一瞬見せない。
      startTransition(() => {
        setOperation(undefined);
        setSending(undefined);
      });
      void reloadLists();
      if (selectedId && currentSearch() === studentLocationSearch({ tab: "thread", id: selectedId })) void reloadThread();
    }
  }

  const views = (data.threads ?? []).map((thread) => toViewThread(thread, data.details[thread.id]));
  const inHistory = detail ? isFinished(detail) : location.tab === "history";
  const error = operationError ?? detailError ?? listError ?? historyError;
  const menu = { tab: location.tab, inHistory, threads: views, activeId: selectedId,
    onTab: (tab: StudentTab) => navigate({ tab }), onOpen: (id: string) => navigate({ tab: "thread", id }) };
  const sourceNotice = sourceId && !source ? (sourceError
    ? <div className="student-error" role="alert"><p>元の会話を読み込めませんでした。{sourceError}</p>
      <button type="button" className="secondary-button" onClick={() => void reloadSource()}>再試行</button></div>
    : <LoadingStatus className="empty">元の会話を読み込んでいます。</LoadingStatus>) : undefined;

  return (
    <>
    <header className="student-heading">
      <StudentMobileMenu {...menu} accountActions={headerActions} />
      <p className="student-course-name"><MathTitle text={course.name} /></p>
      <div className="student-heading-actions">
        <div className="student-refresh" role="status">{(listLoading || detailLoading) && <><Spinner /><span className="visually-hidden">更新中</span></>}</div>
        <StudentNotifications
          notices={(data.notifications ?? []).map((notice) => ({ ...notice, threadId: notice.questionId, read: notice.readAt !== null }))}
          loading={data.notifications === undefined && !notificationError} error={notificationError}
          onReload={reloadLists}
          onOpen={async (notice) => {
            if (!notice.read) {
              const marked = await client.readNotification(notice.id);
              listRequest.current++;
              setData((current) => ({ ...current, notifications: current.notifications?.map((item) => item.id === marked.id ? marked : item) }));
            }
            navigate({ tab: "thread", id: notice.threadId });
            void reloadLists();
          }}
        />
        <div className="course-account-actions">{headerActions}</div>
      </div>
    </header>
    <div className="workspace student-workspace">
      <aside className="sidebar course-sidebar" aria-label="講義メニュー">
        <StudentMenu {...menu} />
      </aside>
      <section className="main-content" aria-label="生徒画面">
        {error && <div className="student-error" role="alert"><p>{error}</p>
          <button type="button" className="secondary-button" disabled={listLoading || detailLoading} onClick={() => { void reloadLists(); void reloadThread(); }}>
            {(listLoading || detailLoading) && <Spinner />}再読み込み
          </button>
        </div>}
        {busy && (!sending || detail?.status === "escalated") && <LoadingStatus className="student-saving">
          {operation === "escalate" ? "先生に相談しています…" : operation === "resolve" ? "質問を解決しています…" : "処理しています…"}
        </LoadingStatus>}
        {operationSuccess && <p className="student-success" role="status">{operationSuccess}</p>}
        {location.tab === "shared" && (data.knowledge ? (
          <SharedQuestions categories={course.categories} shared={data.knowledge.map((item) => ({ ...item, title: item.question }))} />
        ) : (!listError || listLoading) && <LoadingStatus>Q&Aを読み込んでいます。</LoadingStatus>)}
        {location.tab === "history" && (
          !data.threads || historyLoading ? (!listError || listLoading || historyLoading) && <LoadingStatus>質問の履歴を読み込んでいます。</LoadingStatus> :
            <StudentHistory threads={views} categories={course.categories} filters={filters} onFilter={setFilters}
              onOpen={(id) => navigate({ tab: "thread", id })} />
        )}
        {location.tab === "thread" && !detail && (!detailError || detailLoading) && <LoadingStatus>会話を読み込んでいます。</LoadingStatus>}
        {location.tab === "chat" && relatedId && !source && sourceNotice}
        {((location.tab === "chat" && (!relatedId || source)) || (location.tab === "thread" && detail)) && (
          <StudentChat
            key={selectedId ?? `new-${relatedId ?? "blank"}`}
            thread={detail && location.tab === "thread" ? toViewThread(detail, detail) : undefined}
            source={source ? toViewThread(source, source) : undefined} sourceNotice={sourceNotice}
            sample={false} actions={detail?.actions} summaryStatus={detail?.summaryStatus} busy={busy} pendingAction={pendingAction}
            pendingMessage={sending} sharingExcluded={detail?.sharingExcluded}
            onSend={(text) => mutate(() => selectedId ? client.sendMessage(selectedId, text) : client.createQuestion(text, relatedId), { text })}
            onEscalate={() => { if (selectedId) void mutate(() => client.escalate(selectedId), { action: "escalate" }); }}
            onResolve={() => { if (selectedId) void mutate(() => client.resolve(selectedId), { action: "resolve" }); }}
            onRetryAi={() => { if (selectedId) void mutate(() => client.retryAi(selectedId)); }}
            onRetrySummary={() => { if (selectedId) void mutate(() => client.retrySummary(selectedId)); }}
            onRegenerateSummary={() => { if (selectedId) void mutate(() => client.regenerateSummary(selectedId), { successMessage: "新しい別案を先生の確認に送りました。" }); }}
            onOpenKnowledge={setKnowledgeId}
            knowledgeTitles={Object.fromEntries((data.knowledge ?? []).map((item) => [item.id, item.question]))}
            onBack={inHistory ? () => navigate({ tab: "history" }) : undefined}
            onStartRelated={detail && inHistory ? () => navigate({ tab: "chat", sourceQuestionId: detail.id }) : undefined}
          />
        )}
      </section>
    </div>
    {knowledgeId && <StudentKnowledgeDialog key={knowledgeId} knowledgeId={knowledgeId} readKnowledge={client.readKnowledge} onClose={() => setKnowledgeId(undefined)} />}
    </>
  );
}
