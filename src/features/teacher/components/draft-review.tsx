import { useState } from "react";
import { Icon } from "@/components/icon";
import { LoadingStatus } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import type { TeacherWorkflowClient } from "../api/client.ts";
import type { TeacherLists } from "../hooks/use-teacher-lists.ts";
import type { CourseCategory, KnowledgeDraftListDTO } from "../workflow-types.ts";
import { CategoryFilter } from "./category-filter";
import { DismissedDrafts } from "./dismissed-drafts";
import { DraftDialog } from "./draft-dialog";
import styles from "./teacher.module.css";

/** 開いて確認できる候補：確認できる版（選択中の案）があるもの。初回の要約中・初回の要約失敗は件数だけ出す。 */
type ReviewableDraft = KnowledgeDraftListDTO & { question: string };

function isReviewable(draft: KnowledgeDraftListDTO): draft is ReviewableDraft {
  return draft.question !== null;
}

export function DraftReview({ client, lists, failed, categories, categoryName, refresh, setNotice,
  selectedId, dismissedId, onOpen, onOpenDismissed, onOpenThread, onClose }: {
  client: TeacherWorkflowClient;
  lists: TeacherLists;
  failed: boolean;
  categories: CourseCategory[];
  categoryName: (id: string | undefined) => string;
  refresh: () => Promise<void>;
  setNotice: (notice: string) => void;
  /** URL で開いている候補 */
  selectedId: string | undefined;
  /** URL で開いている見送った候補 */
  dismissedId: string | undefined;
  onOpen: (id: string) => void;
  onOpenDismissed: (id: string) => void;
  /** 質問対応のタブで会話を開く */
  onOpenThread: (id: string) => void;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<string[]>([]);
  const matches = (draft: KnowledgeDraftListDTO) => !selection.length || selection.includes(draft.categoryId);
  const matchingDrafts = lists.drafts?.filter(matches);
  const drafts = matchingDrafts?.filter(isReviewable);
  // まだ案が1つもない候補（初回の生成中・初回の生成失敗）は開いても確認できる内容がない。
  const firstGenerating = matchingDrafts?.filter((draft) => !isReviewable(draft) && draft.status === "generating").length ?? 0;
  // 失敗した候補は、会話を開けばもう一度AIで作れるので、そこへの入口を出す。
  const firstFailed = matchingDrafts?.filter((draft) => !isReviewable(draft) && draft.status === "failed") ?? [];
  const threadTitle = (id: string) =>
    [...(lists.escalated ?? []), ...(lists.answered ?? []), ...(lists.aiAnswered ?? [])].find((thread) => thread.id === id)?.title;

  const finish = (notice: string) => {
    onClose();
    setNotice(notice);
    void refresh();
  };

  return (
    <>
      <div className="view-heading">
        <h1>Q&amp;A確認</h1>
        <p>タイトルを見て、講義の生徒に共有したい質問を選びます。</p>
      </div>
      <CategoryFilter categories={categories} selected={selection} onChange={setSelection} />
      <section className="surface review-panel" aria-label="共有候補">
        <div className="panel-heading">
          <h2>共有候補</h2>{drafts && <span className="count">{drafts.length}件</span>}
        </div>
        {drafts && drafts.length > 0 && (
          <ul className="item-list">
            {drafts.map((draft) => (
              <li key={draft.questionId}>
                <button type="button" className="list-button" onClick={() => {
                  setNotice("");
                  onOpen(draft.questionId);
                }}>
                  <span className="item-mark"><Icon name="book" /></span>
                  <span className={styles.draftTitle}>
                    <span className="subject-label">{categoryName(draft.categoryId)}</span>
                    <strong><MathTitle text={draft.question} /></strong>
                    <span className={styles.draftMeta}>
                      {draft.versionCount > 1 && `案 ${draft.versionCount}件`}
                      {draft.versionCount > 1 && !draft.questionResolved && "・"}
                      {!draft.questionResolved && "相談は未解決"}
                    </span>
                  </span>
                  {draft.status === "generating"
                    ? <span className="badge">新しい案を作成中</span>
                    : <span className="badge badge--waiting">確認待ち</span>}
                  <span className="card-link">内容を確認 <Icon name="arrow" size={15} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {drafts?.length === 0 && (
          <p className="empty">{selection.length ? "選んだカテゴリに確認待ちの候補はありません。"
            : "確認する候補はありません。生徒が「解決した」を押すか、質問対応の会話から「共有候補をAIで作る」を押すと、ここに候補が届きます。"}</p>
        )}
        {firstGenerating > 0 && (
          <p className={`${styles.hint} ${styles.panelNote}`} role="status">
            AIが最初の案を作成中の候補が{firstGenerating}件あります。できあがると一覧に表示されます。
          </p>
        )}
        {firstFailed.length > 0 && (
          <div className={styles.panelNote}>
            <p className={styles.hint} role="status">
              最初の案の作成に失敗した候補が{firstFailed.length}件あります。会話を開くと、もう一度AIで作れます。
            </p>
            <ul className={styles.failedDrafts}>
              {firstFailed.map((draft) => (
                <li key={draft.questionId}>
                  <button type="button" className="text-button" onClick={() => {
                    setNotice("");
                    onOpenThread(draft.questionId);
                  }}>
                    <span><MathTitle text={threadTitle(draft.questionId) ?? "タイトルを取得できない質問"} />の会話を開く</span> <Icon name="arrow" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!drafts && (failed ? <p className="empty">候補を読み込めませんでした。</p> : <LoadingStatus className="empty">読み込み中です…</LoadingStatus>)}
      </section>
      <DismissedDrafts client={client} drafts={lists.dismissed?.filter(matches)} failed={failed} categories={categories}
        categoryName={categoryName} refresh={refresh} setNotice={setNotice}
        selectedId={dismissedId} onOpen={onOpenDismissed} onClose={onClose} />
      {selectedId && (
        <DraftDialog
          key={selectedId}
          client={client}
          questionId={selectedId}
          expected="none"
          categories={categories}
          onClose={onClose}
          onFinished={finish}
          onConflict={refresh}
        />
      )}
    </>
  );
}
