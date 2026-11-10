import { useCallback, useState } from "react";
import { LoadingStatus } from "@/components/loading-status";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { isStale, TeacherApiError } from "../api/errors.ts";
import { useAsyncData } from "../hooks/use-async-data.ts";
import { useNarrowScreen } from "../hooks/use-narrow-screen.ts";
import type { CourseCategory, DraftPublicationFilter } from "../workflow-types.ts";
import { DraftConversation } from "./draft-conversation";
import { type DraftAction, DraftForm } from "./draft-form";
import { DraftViewer } from "./draft-viewer";
import { LoadError } from "./load-error";
import { TeacherDialog } from "./teacher-dialog";
import styles from "./teacher.module.css";

const staleNotices: Record<DraftPublicationFilter, string> = {
  none: "この候補は、すでに共有されたか見送られています。一覧は最新の状態に更新しました。",
  dismissed: "この候補は、見送った候補ではなくなりました。一覧は最新の状態に更新しました。",
};
const goneNotice = "この候補は見つかりませんでした。一覧は最新の状態に更新しました。";

/**
 * 候補を、元の会話と並べて表示するダイアログ。
 * 未公開の候補は案を選んで編集・共有・見送り、見送った候補は閲覧だけ。
 * 開いたときに状態が変わっていたら、いきなり閉じずに理由をダイアログの中で伝える。
 */
export function DraftDialog({ client, questionId, expected, categories, onClose, onFinished, onConflict }: {
  client: TeacherWorkflowClient;
  questionId: string;
  /** 一覧で見えていた公開状態。開いたときに変わっていたら、一覧を取り直す */
  expected: DraftPublicationFilter;
  categories: CourseCategory[];
  onClose: () => void;
  onFinished: (notice: string) => void;
  onConflict: () => Promise<void>;
}) {
  const fetchDraft = useCallback(async () => {
    const draft = await client.readDraft(questionId);
    if (draft.publication !== expected) throw new TeacherApiError("CONFLICT", staleNotices[expected]);
    return draft;
  }, [client, questionId, expected]);
  const [unavailable, setUnavailable] = useState<string>();
  const { data: draft, setData: setDraft, error: loadError, reload } = useAsyncData(fetchDraft, (cause) => {
    if (!isStale(cause)) return false;
    setUnavailable(cause instanceof TeacherApiError && cause.code === "NOT_FOUND" ? goneNotice : staleNotices[expected]);
    void onConflict();
    return true;
  });
  const [busy, setBusy] = useState<DraftAction>();
  const [dirty, setDirty] = useState(false);

  const title = expected === "none" ? "共有するQ&Aを確認" : "見送った候補";
  // 狭い画面の未公開の候補はタブで切り替える。見送った候補は閲覧だけで短いので、縦に並べたままにする。
  const tabbed = useNarrowScreen() && expected === "none" && !unavailable;
  const conversation = <DraftConversation client={client} questionId={questionId} />;
  return (
    <TeacherDialog title={title} busy={Boolean(busy)} dirty={dirty} wide={!unavailable} fill={tabbed} onClose={onClose}>
      {unavailable ? (
        <>
          <p className="dialog-intro" role="status">{unavailable}</p>
          <div className={styles.actionsEnd}>
            <button type="button" className="primary-button" onClick={onClose}>一覧に戻る</button>
          </div>
        </>
      ) : (
        // 画面の回転でタブ表示と切り替わっても入力が消えないよう、DraftForm の位置は変えない。
        <div className={tabbed ? styles.tabsHost : styles.split}>
          <div className={tabbed ? styles.tabsHost : styles.splitMain}>
            {draft ? (
              expected === "none" ? (
                <DraftForm client={client} draft={draft} categories={categories} busy={busy} setBusy={setBusy}
                  onDraftChange={setDraft} onDirtyChange={setDirty} onFinished={onFinished} onConflict={onConflict}
                  source={tabbed ? conversation : undefined} />
              ) : (
                <DraftViewer
                  client={client}
                  draft={draft}
                  categories={categories}
                  busy={busy}
                  setBusy={setBusy}
                  onFinished={onFinished}
                  onConflict={onConflict}
                />
              )
            ) : loadError ? (
              <LoadError message={loadError} onRetry={reload} />
            ) : (
              <LoadingStatus className={styles.status}>候補を読み込み中です…</LoadingStatus>
            )}
          </div>
          {!tabbed && conversation}
        </div>
      )}
    </TeacherDialog>
  );
}
