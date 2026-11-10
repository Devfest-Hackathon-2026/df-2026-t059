"use client";

import { useState } from "react";
import { LoadingStatus, Spinner } from "@/components/loading-status";
import { Icon } from "@/components/icon";
import { MessageBody } from "@/components/message-body";
import { MathTitle } from "@/components/math-title";
import type { TeacherWorkflowClient } from "../api/client.ts";
import { isStale, messageOf, TeacherApiError } from "../api/errors.ts";
import type { CourseCategory, PublishedKnowledgeDTO } from "../workflow-types.ts";
import { CategoryFilter } from "./category-filter";
import styles from "./teacher.module.css";

/**
 * 同じ講義の生徒に公開中のQ&A。
 * 公開の取り下げができ、元候補がある場合は確認待ち（Q&A確認）に戻して再編集・再公開できる。
 */
export function PublishedKnowledge({
  client,
  items,
  failed,
  categories,
  categoryName,
  refresh,
  setNotice,
  onOpenDraft,
  onDraftReturned,
}: {
  client?: TeacherWorkflowClient;
  items: PublishedKnowledgeDTO[] | undefined;
  failed: boolean;
  categories: CourseCategory[];
  categoryName: (id: string | undefined) => string;
  refresh?: () => Promise<void>;
  setNotice?: (notice: string) => void;
  onOpenDraft?: (questionId: string) => void;
  /** 取り下げで候補が確認待ちに戻るとき（先生自身の操作なので通知の新着にしない） */
  onDraftReturned?: (questionId: string) => void;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [itemError, setItemError] = useState<{ id: string; message: string } | null>(null);
  const [restoredQuestionId, setRestoredQuestionId] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const matching = items?.filter((item) => !selection.length || selection.includes(item.categoryId));

  const handleUnpublish = async (item: PublishedKnowledgeDTO) => {
    if (!client) return;
    setBusyId(item.id);
    setItemError(null);
    try {
      const result = await client.unpublishKnowledge(item.id);
      if (result.questionId) onDraftReturned?.(result.questionId);
      setConfirmingId(null);
      await refresh?.();
      if (result.questionId) {
        // 「候補を開いて編集する」付きの案内を出すので、共通の通知は重ねない。
        setRestoredQuestionId(result.questionId);
        setNotice?.("");
      } else {
        setRestoredQuestionId(null);
        setNotice?.("Q&Aを取り下げました。");
      }
    } catch (cause) {
      if (isStale(cause)) {
        await refresh?.();
        setItemError({
          id: item.id,
          message:
            cause instanceof TeacherApiError && cause.code === "NOT_FOUND"
              ? "このQ&Aはすでに取り下げられているか、見つかりませんでした。一覧を最新に更新しました。"
              : "このQ&Aの状態が変更されたため、一覧を最新に更新しました。",
        });
      } else {
        setItemError({ id: item.id, message: messageOf(cause) });
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="view-heading">
        <h1>共有済みQ&amp;A</h1>
        <p>同じ講義の生徒に公開しているQ&amp;Aです。取り下げると生徒には非公開になり、Q&amp;A確認から再編集・再公開できます。</p>
      </div>
      <CategoryFilter categories={categories} selected={selection} onChange={setSelection} />
      {restoredQuestionId && onOpenDraft && (
        <p className="view-notice" role="status">
          <Icon name="check" /> 公開を取り下げ、候補をQ&amp;A確認に戻しました。
          <button
            type="button"
            className="text-button"
            onClick={() => {
              const qid = restoredQuestionId;
              setRestoredQuestionId(null);
              onOpenDraft(qid);
            }}
          >
            候補を開いて編集する
          </button>
        </p>
      )}
      <section className="surface" aria-label="共有済みQ&A">
        <div className="panel-heading">
          <h2>公開中</h2>{matching && <span className="count">{matching.length}件</span>}
        </div>
        {matching && matching.length > 0 && (
          <ul className="item-list">
            {matching.map((item) => {
              const isConfirming = confirmingId === item.id;
              const isBusy = busyId === item.id;
              const error = itemError?.id === item.id ? itemError.message : null;

              return (
                <li key={item.id}>
                  <details className="shared-item">
                    <summary>
                      <span className="item-mark"><Icon name="book" /></span>
                      <span className={styles.draftTitle}>
                        <span className="subject-label">{categoryName(item.categoryId)}</span>
                        <strong><MathTitle text={item.question} /></strong>
                      </span>
                    </summary>
                    <MessageBody text={item.answer} className="shared-answer" />
                    {error && <p className={styles.error} role="alert">{error}</p>}
                    <div className={styles.publishedFooter}>
                      <span>{new Date(item.publishedAt).toLocaleDateString("ja-JP")} に共有</span>
                      {client && (
                        <div>
                          {isConfirming ? (
                            <div className={styles.confirmInline}>
                              <span>取り下げますか？（生徒には非公開になります）</span>
                              <button
                                type="button"
                                className="text-button"
                                disabled={isBusy}
                                onClick={() => setConfirmingId(null)}
                              >
                                キャンセル
                              </button>
                              <button
                                type="button"
                                className="primary-button"
                                disabled={isBusy}
                                onClick={() => handleUnpublish(item)}
                              >
                                {isBusy && <Spinner />}
                                {isBusy ? "取り下げ中…" : "取り下げる"}
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="text-button"
                              disabled={isBusy}
                              onClick={() => {
                                setItemError(null);
                                setConfirmingId(item.id);
                              }}
                            >
                              公開を取り下げる
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        {matching?.length === 0 && <p className="empty">{selection.length ? "選んだカテゴリに共有済みのQ&Aはありません。"
          : "共有済みのQ&Aはありません。Q&A確認から共有できます。"}</p>}
        {!items && (failed ? <p className="empty">共有済みのQ&Aを読み込めませんでした。</p> : <LoadingStatus className="empty">読み込み中です…</LoadingStatus>)}
      </section>
    </>
  );
}
