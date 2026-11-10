import { useState } from "react";
import { MessageBody } from "@/components/message-body";
import { MathTitle } from "@/components/math-title";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { isStale, messageOf, TeacherApiError } from "../api/errors.ts";
import type { CourseCategory, KnowledgeDraftDTO } from "../workflow-types.ts";
import type { DraftAction } from "./draft-form";
import styles from "./teacher.module.css";

/**
 * 見送った候補の閲覧と確認待ちへの復帰。
 */
export function DraftViewer({
  client,
  draft,
  categories,
  busy,
  setBusy,
  onFinished,
  onConflict,
}: {
  client: TeacherWorkflowClient;
  draft: KnowledgeDraftDTO;
  categories: CourseCategory[];
  /** ダイアログと共有する処理中の状態（処理中は閉じられない） */
  busy: DraftAction | undefined;
  setBusy: (action: DraftAction | undefined) => void;
  onFinished: (notice: string) => void;
  onConflict: () => Promise<void>;
}) {
  const version = draft.versions.find((item) => item.id === draft.selectedVersionId);
  const categoryName = categories.find((category) => category.id === version?.categoryId)?.name ?? "未分類";

  const [error, setError] = useState<string>();

  const restore = async () => {
    setBusy("restore");
    setError(undefined);
    try {
      await client.restoreDraft(draft.questionId);
      onFinished("候補を確認待ちに戻しました。Q&A確認から編集・共有できます。");
    } catch (cause) {
      if (isStale(cause)) {
        await onConflict();
        setError(
          cause instanceof TeacherApiError && cause.code === "NOT_FOUND"
            ? "この候補は見つかりませんでした。一覧を最新に更新しました。"
            : "この候補の状態が変わったため、一覧を最新に更新しました。",
        );
      } else {
        setError(messageOf(cause));
      }
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <p className="dialog-intro">見送った候補は生徒に表示されません。見送ったときに選んでいた案を表示しています。</p>
      {version ? (
        <dl className={styles.readonly}>
          <dt>タイトル</dt><dd><MathTitle text={version.question} /></dd>
          <dt>回答</dt><dd><MessageBody text={version.answer} /></dd>
          <dt>カテゴリ</dt><dd>{categoryName}</dd>
        </dl>
      ) : (
        <p className={styles.status}>表示できる案がありません。</p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.formActions}>
        <div />
        <div className={styles.formActionsMain}>
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busy) || !version}
            onClick={restore}
          >
            {busy ? "復帰中…" : "確認待ちに戻す"}
          </button>
        </div>
      </div>
    </>
  );
}
