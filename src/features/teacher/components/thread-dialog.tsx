import { type FormEvent, useCallback, useLayoutEffect, useRef, useState } from "react";
import { LoadingStatus } from "@/components/loading-status";
import { MathTitle } from "@/components/math-title";
import { MESSAGE_MAX_LENGTH } from "../../../domain/limits.ts";
import { Icon } from "@/components/icon";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { isStale, messageOf } from "../api/errors.ts";
import { useAsyncData } from "../hooks/use-async-data.ts";
import { AnswerPreview } from "./answer-preview";
import { LoadError } from "./load-error";
import { TeacherDialog } from "./teacher-dialog";
import styles from "./teacher.module.css";
import { ThreadMessages } from "./thread-messages";

/** 質問の会話と返信。開いたときに見られなくなっていたら、いきなり閉じずに理由をダイアログの中で伝える。 */
export function ThreadDialog({ client, questionId, listTitle, onClose, onChanged }: {
  client: TeacherWorkflowClient;
  questionId: string;
  /** 一覧で分かっている題名。URL を直接開いて一覧がまだないときは、会話を読み込むまで仮の題名を出す */
  listTitle: string | undefined;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [gone, setGone] = useState(false);
  const fetchThread = useCallback(() => client.readThread(questionId), [client, questionId]);
  const { data: detail, setData: setDetail, error: loadError, loading, reload } = useAsyncData(fetchThread, (cause) => {
    if (!isStale(cause)) return false;
    setGone(true);
    void onChanged();
    return true;
  });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [conflicted, setConflicted] = useState(false);
  const [sent, setSent] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string>();
  const [draftError, setDraftError] = useState<string>();

  // 返信できるか（対応待ちで未解決）はサーバーが判定した値を使う。
  const canReply = detail?.actions.canReply === true;
  const summaryStatus = detail?.summaryStatus;
  // 共有済み・見送り済み・作成中の候補には作らない（作っても Q&A確認 に出ない案になる）。
  const draftOpen = summaryStatus === "none" || summaryStatus === "failed" || summaryStatus === "ready";
  // 対応待ちで、要約の根拠になる回答がまだない会話。先生の回答も AI の確かな回答もないと、要約は必ず失敗する
  // （AI が引き継いだ最後の回答は要約に使われない）。失敗の記録を残さず Gemini も呼ばないよう、回答を促す。
  const assistantReplies = detail?.messages.filter((message) => message.role === "assistant").length ?? 0;
  const hasAnswer = detail?.messages.some((message) => message.role === "teacher")
    || assistantReplies > (detail?.escalatedBy === "ai" ? 1 : 0);
  const awaitingAnswer = canReply && !hasAnswer;
  const canRequestDraft = detail?.actions.canRequestDraft === true && draftOpen && !awaitingAnswer;
  // 案がまだない（未作成・最初の作成に失敗）なら「作る」。失敗した作成は案を残さないため、retry で作り直す。
  const firstDraft = summaryStatus !== "ready";
  const busy = sending || drafting;
  const title = detail?.title ?? listTitle ?? "質問の会話";

  // 回答が必要なのは最後の発言なので、開いたときと発言が増えたときは最新までスクロールする。
  const conversationRef = useRef<HTMLDivElement>(null);
  const messageCount = detail?.messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 発言数が変わったときだけスクロールする
  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [messageCount]);

  /** AIで共有候補を作る。先生がボタンを押したときだけ Gemini を1回呼ぶ。 */
  const requestDraft = async () => {
    if (busy || !detail || !canRequestDraft) return;
    setDrafting(true);
    setDraftNotice(undefined);
    setDraftError(undefined);
    try {
      const draft = await client.requestDraft(questionId, summaryStatus === "failed" ? "retry" : "regenerate");
      if (draft.publication !== "none") {
        setDraftError("この候補は、ほかの先生がすでに共有したか見送りました。");
      } else if (draft.lastGeneration?.status === "failed") {
        setDraftError("AIで共有候補を作れませんでした。会話に回答の根拠が足りないと作れません。先生の回答を送ってから、もう一度お試しください。");
      } else {
        setDraftNotice(firstDraft
          ? "共有候補を作りました。「Q&A確認」から確認して共有できます。"
          : "共有候補に新しい案を追加しました。「Q&A確認」から確認できます。");
      }
      void onChanged();
      await reload();
    } catch (cause) {
      setDraftError(messageOf(cause));
      if (isStale(cause)) {
        void onChanged();
        await reload();
      }
    } finally {
      setDrafting(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reply = text.trim();
    if (!reply || busy) return;
    setSending(true);
    setSendError(undefined);
    setConflicted(false);
    try {
      setDetail(await client.reply(questionId, reply));
      setText("");
      setSent(true);
      void onChanged();
    } catch (cause) {
      if (isStale(cause)) {
        // 別の先生が先に回答した場合は、最新の会話を読み直して見せる。
        setConflicted(true);
        void onChanged();
        await reload();
      } else {
        setSendError(messageOf(cause));
      }
    } finally {
      setSending(false);
    }
  };

  if (gone) {
    return (
      <TeacherDialog title={<MathTitle text={title} />} dirty={text.trim() !== ""} onClose={onClose}>
        <p className="dialog-intro" role="status">この質問は表示できなくなりました。一覧は最新の状態に更新しました。</p>
        {text.trim() && (
          <div className="dialog-form">
            <label>送信できなかった回答（コピーできます）
              <textarea rows={3} value={text} readOnly />
            </label>
          </div>
        )}
        <div className={styles.actionsEnd}>
          <button type="button" className="primary-button" onClick={onClose}>一覧に戻る</button>
        </div>
      </TeacherDialog>
    );
  }

  return (
    <TeacherDialog title={<MathTitle text={title} />} busy={busy} dirty={text.trim() !== ""} onClose={onClose}>
      {detail && (
        <p className="dialog-intro">
          {studentLabel(detail.student.displayName)}
          {detail.escalatedBy && canReply && (detail.escalatedBy === "ai" ? "AIが先生に引き継いだ質問です。" : "生徒が先生への相談を選んだ質問です。")}
          {detail.resolvedAt && (detail.status === "escalated"
            ? "先生の返信の前に、生徒が解決済みにしたため返信できません。"
            : "生徒はこの相談を解決済みにしています。")}
        </p>
      )}
      {detail ? (
        <div className="dialog-conversation" ref={conversationRef}><ThreadMessages messages={detail.messages} /></div>
      ) : !loadError && <LoadingStatus className={styles.status}>会話を読み込み中です…</LoadingStatus>}
      {sent && <p className="view-notice" role="status"><Icon name="check" /> 回答を送信しました。</p>}
      {conflicted && !loading && (
        <p className={styles.error} role="alert">
          {loadError
            ? "別の先生が先に回答したか、対応待ちではなくなりましたが、最新の会話を読み込めませんでした。"
            : "別の先生が先に回答したか、対応待ちではなくなりました。最新の会話を表示しています。"}
        </p>
      )}
      {loadError && <LoadError message={loadError} onRetry={reload} />}
      {sendError && <p className={styles.error} role="alert">{sendError}</p>}
      {canReply && (
        <form className="dialog-form" onSubmit={submit}>
          <label>先生の回答
            <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)}
              placeholder="質問した生徒に返す内容" required maxLength={MESSAGE_MAX_LENGTH} disabled={busy} />
          </label>
          <AnswerPreview text={text} collapsible />
          <button type="submit" className="primary-button" disabled={!text.trim() || busy}>
            {sending ? "送信中…" : "回答を送る"}
          </button>
        </form>
      )}
      {detail && !canReply && text.trim() && (
        <div className="dialog-form">
          <label>送信できなかった回答（コピーできます）
            <textarea rows={3} value={text} readOnly />
          </label>
        </div>
      )}
      {detail && (canRequestDraft || awaitingAnswer || drafting || draftNotice || draftError) && (
        <section className={styles.draftRequest} aria-label="共有候補">
          {awaitingAnswer && !drafting && <p className={styles.hint}>回答を送ると、この会話からQ&amp;Aの共有候補をAIで作れます。</p>}
          {canRequestDraft && (
            <p className={styles.hint}>
              {summaryStatus === "none"
                ? "この会話から、講義の生徒に共有するQ&Aの候補をAIで作れます。作っても相談は解決済みになりません。"
                : summaryStatus === "failed"
                  ? "前回の共有候補の作成に失敗しました。もう一度AIで作れます。"
                  : "この会話の共有候補に、AIで新しい案を追加できます。今ある案は残ります。"}
            </p>
          )}
          {draftNotice && <p className="view-notice" role="status"><Icon name="check" /> {draftNotice}</p>}
          {draftError && <p className={styles.error} role="alert">{draftError}</p>}
          {(canRequestDraft || drafting) && (
            <div className={styles.actionsEnd}>
              <button type="button" className="secondary-button" disabled={busy} onClick={requestDraft}>
                {drafting ? "AIが作成中…" : firstDraft ? "共有候補をAIで作る" : "AIで別の案を作る"}
              </button>
            </div>
          )}
        </section>
      )}
    </TeacherDialog>
  );
}

/** 相談した生徒の表示。担当教員だけに返る、相談作成時点の Google 表示名（なければ検証済みメール）。 */
function studentLabel(displayName: string | null) {
  return displayName ? `${displayName} さんの相談です。` : "";
}
