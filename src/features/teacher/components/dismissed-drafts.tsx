import { Icon } from "@/components/icon";
import { LoadingStatus } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import type { TeacherWorkflowClient } from "../api/client.ts";
import type { CourseCategory, KnowledgeDraftListDTO } from "../workflow-types.ts";
import { DraftDialog } from "./draft-dialog";
import styles from "./teacher.module.css";

/** 見送った候補の一覧。開くと中身と元の会話を確認でき、確認待ちに戻せる。 */
export function DismissedDrafts({ client, drafts, failed, categories, categoryName, refresh, setNotice, selectedId, onOpen, onClose }: {
  client: TeacherWorkflowClient;
  drafts: KnowledgeDraftListDTO[] | undefined;
  failed: boolean;
  categories: CourseCategory[];
  categoryName: (id: string | undefined) => string;
  refresh: () => Promise<void>;
  setNotice: (notice: string) => void;
  /** URL で開いている見送った候補 */
  selectedId: string | undefined;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <details className={`surface ${styles.collapsible}`}>
        <summary className="panel-heading">
          <h2>見送った候補</h2>{drafts && <span className="count">{drafts.length}件</span>}
        </summary>
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
                    <strong><MathTitle text={draft.question ?? "（表示できる案がありません）"} /></strong>
                  </span>
                  <span className="badge">見送り済み</span>
                  <span className="card-link">内容を見る <Icon name="arrow" size={15} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {drafts?.length === 0 && <p className="empty">見送った候補はありません。</p>}
        {!drafts && (failed ? <p className="empty">見送った候補を読み込めませんでした。</p> : <LoadingStatus className="empty">読み込み中です…</LoadingStatus>)}
      </details>
      {selectedId && (
        <DraftDialog
          key={selectedId}
          client={client}
          questionId={selectedId}
          expected="dismissed"
          categories={categories}
          onClose={onClose}
          onFinished={(notice) => {
            onClose();
            setNotice(notice);
            void refresh();
          }}
          onConflict={refresh}
        />
      )}
    </>
  );
}
