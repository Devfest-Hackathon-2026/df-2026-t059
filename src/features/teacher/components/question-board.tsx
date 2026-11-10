import { Icon } from "@/components/icon";
import { LoadingStatus } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { formatDateTime } from "../format.ts";
import { needsReply, type TeacherLists } from "../hooks/use-teacher-lists.ts";
import type { ThreadSummaryDTO } from "../workflow-types.ts";
import styles from "./teacher.module.css";
import { ThreadDialog } from "./thread-dialog";

/**
 * 先生のタスク（対応待ち）を主に表示し、対応が済んだものは折りたたみに置く。
 * 返信を待たずに生徒が解決した相談は、状態が escalated のままでも対応待ちには出さない。
 */
export function QuestionBoard({ client, lists, failed, categoryName, refresh, setNotice, selectedId, onOpen, onClose }: {
  client: TeacherWorkflowClient;
  lists: TeacherLists;
  failed: boolean;
  categoryName: (id: string | undefined) => string;
  refresh: () => Promise<void>;
  setNotice: (notice: string) => void;
  /** URL で開いている質問。一覧の更新で対応待ちから回答済みに移っても、開いている会話は閉じない */
  selectedId: string | undefined;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  // 待たせている順（古い順）に並べる。
  const waiting = lists.escalated?.filter(needsReply).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  // 回答済みと、返信前に生徒が解決したもの。新しい順。
  const done = lists.answered && lists.escalated && [
    ...lists.answered,
    ...lists.escalated.filter((thread) => !needsReply(thread)),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = (thread: ThreadSummaryDTO) => {
    setNotice("");
    onOpen(thread.id);
  };
  const aiThreads = lists.aiAnswered && [...lists.aiAnswered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selectedTitle = [...(lists.escalated ?? []), ...(lists.answered ?? []), ...(lists.aiAnswered ?? [])]
    .find(({ id }) => id === selectedId)?.title;

  return (
    <>
      <div className="view-heading">
        <h1>質問対応</h1>
        <p>先生の回答を待っている質問です。会話の続きから回答できます。</p>
      </div>
      <section aria-labelledby="waiting-heading">
        <div className={styles.sectionHeading}>
          <span className="lane-dot lane-dot--waiting" aria-hidden="true" />
          <h2 id="waiting-heading">対応待ち</h2>
          {waiting && <span className="count">{waiting.length}件</span>}
        </div>
        {waiting && waiting.length > 0 && (
          <div className={styles.taskGrid}>
            {waiting.map((thread) => (
              <button type="button" className="surface board-card" key={thread.id} onClick={() => open(thread)}>
                <span className="subject-label">{categoryName(thread.categoryIds[0])}</span>
                <strong><MathTitle text={thread.title} /></strong>
                <span className={styles.draftMeta}>最終更新 {formatDateTime(thread.updatedAt)}</span>
                <span className="card-link">会話を開く <Icon name="arrow" size={15} /></span>
              </button>
            ))}
          </div>
        )}
        {waiting?.length === 0 && <p className="surface empty">対応待ちの質問はありません。</p>}
        {!waiting && (failed ? <p className="surface empty">読み込めませんでした。</p> : <LoadingStatus className="surface empty">読み込み中です…</LoadingStatus>)}
      </section>
      <details className={`surface ${styles.collapsible}`}>
        <summary className="panel-heading">
          <h2>対応済み</h2>{done && <span className="count">{done.length}件</span>}
        </summary>
        {done && done.length > 0 && (
          <ul className="item-list">
            {done.map((thread) => (
              <li key={thread.id}>
                <button type="button" className="list-button" onClick={() => open(thread)}>
                  <span className={styles.draftTitle}>
                    <span className="subject-label">{categoryName(thread.categoryIds[0])}</span>
                    <strong><MathTitle text={thread.title} /></strong>
                    <span className={styles.draftMeta}>最終更新 {formatDateTime(thread.updatedAt)}</span>
                  </span>
                  {thread.status === "escalated"
                    ? <span className="badge badge--resolved">{thread.sharingExcluded ? "解決済み · 非共有" : "返信前に生徒が解決"}</span>
                    : <span className="badge badge--answered">回答済み</span>}
                  <span className="card-link">会話を見る <Icon name="arrow" size={15} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {done?.length === 0 && <p className="empty">対応済みの質問はありません。</p>}
        {!done && (failed ? <p className="empty">読み込めませんでした。</p> : <LoadingStatus className="empty">読み込み中です…</LoadingStatus>)}
      </details>
      <details className={`surface ${styles.collapsible}`}>
        <summary className="panel-heading">
          <h2>AIが対応した会話</h2>{aiThreads && <span className="count">{aiThreads.length}件</span>}
        </summary>
        {aiThreads && aiThreads.length > 0 && (
          <>
            <p className={`${styles.hint} ${styles.listNote}`}>先生の回答のあとに生徒が続きを質問した会話も、ここに移ります。</p>
            <ul className="item-list">
              {aiThreads.map((thread) => (
                <li key={thread.id}>
                  <button type="button" className="list-button" onClick={() => open(thread)}>
                    <span className={styles.draftTitle}>
                      <span className="subject-label">{categoryName(thread.categoryIds[0])}</span>
                      <strong><MathTitle text={thread.title} /></strong>
                      <span className={styles.draftMeta}>最終更新 {formatDateTime(thread.updatedAt)}</span>
                    </span>
                    {thread.resolvedAt
                      ? <span className="badge badge--resolved">解決済み</span>
                      : <span className="badge">進行中</span>}
                    <span className="card-link">会話を見る <Icon name="arrow" size={15} /></span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {aiThreads?.length === 0 && <p className="empty">AIが対応した会話はありません。</p>}
        {!aiThreads && (failed ? <p className="empty">読み込めませんでした。</p> : <LoadingStatus className="empty">読み込み中です…</LoadingStatus>)}
      </details>
      {selectedId && (
        <ThreadDialog
          key={selectedId}
          client={client}
          questionId={selectedId}
          listTitle={selectedTitle}
          onClose={onClose}
          onChanged={refresh}
        />
      )}
    </>
  );
}
