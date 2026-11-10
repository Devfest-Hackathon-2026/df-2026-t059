import { useCallback } from "react";
import { LoadingStatus } from "@/components/loading-status";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { useAsyncData } from "../hooks/use-async-data.ts";
import { LoadError } from "./load-error";
import styles from "./teacher.module.css";
import { ThreadMessages } from "./thread-messages";

/** 候補の元になった会話。編集・閲覧の横に並べて表示する。保護された詳細APIから取得する。 */
export function DraftConversation({ client, questionId }: { client: TeacherWorkflowClient; questionId: string }) {
  const fetchThread = useCallback(() => client.readThread(questionId), [client, questionId]);
  const { data: thread, error, reload } = useAsyncData(fetchThread);

  return (
    <section className={styles.sourcePanel} aria-label="元の会話">
      <h3 className={styles.sourceHeading}>元の会話</h3>
      <div className={styles.sourceScroll}>
        {thread && <ThreadMessages messages={thread.messages} />}
        {error && <LoadError message={error} onRetry={reload} />}
        {!thread && !error && <LoadingStatus className={styles.status}>会話を読み込み中です…</LoadingStatus>}
      </div>
    </section>
  );
}
