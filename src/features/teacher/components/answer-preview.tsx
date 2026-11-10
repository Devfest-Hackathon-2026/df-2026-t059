import { type ReactNode, useDeferredValue, useState } from "react";
import { MathTitle } from "@/components/math-title";
import { MessageBody } from "@/components/message-body";
import styles from "./teacher.module.css";

function PreviewBody({ text }: { text: string }) {
  // 入力の反応を優先し、Markdown・数式の処理は少し遅れてよい。
  const deferred = useDeferredValue(text);
  return deferred.trim()
    ? <div className={styles.previewBody}><MessageBody text={deferred} /></div>
    : <p className={styles.previewHint}>回答を入力すると、ここに表示されます。</p>;
}

/**
 * 入力中の回答が生徒の画面でどう見えるかのプレビュー。
 * 既定は常に表示する（見比べながら書くため）。`collapsible` は縦の余裕がない返信欄用の折りたたみ。
 */
export function AnswerPreview({ text, title, collapsible = false }: { text: string; title?: string; collapsible?: boolean }) {
  const [open, setOpen] = useState(false);
  const previewTitle = useDeferredValue(title?.trim());
  let body: ReactNode = <PreviewBody text={text} />;
  if (!collapsible) {
    return (
      <section className={styles.answerPreview} aria-label="プレビュー">
        <h3 className={styles.previewHeading}>プレビュー</h3>
        {previewTitle && <h4 className={styles.studentPreviewTitle}><MathTitle text={previewTitle} /></h4>}
        {body}
      </section>
    );
  }
  // 閉じている間は描画しない（入力ごとに Markdown・数式を処理しない）。
  if (!open) body = null;
  return (
    <details className={styles.answerPreview} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.answerPreviewSummary}>プレビュー</summary>
      {body}
    </details>
  );
}
